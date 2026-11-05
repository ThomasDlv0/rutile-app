//! Vérification de bout en bout, lancée par `rutile --self-test` sur l'app installée : chaque
//! conversion de la roue, sur des fichiers d'exemple créés pour l'occasion, puis la validité de
//! chaque fichier produit. Sert à l'intégration continue sur les trois systèmes.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use image::{DynamicImage, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};

use crate::video::{self, VideoFormat};
use crate::{InputFormat, OutputFormat, Quality, decode};

/// Format lu dans le fichier produit, pour chaque format de sortie des images.
fn expected(format: OutputFormat) -> InputFormat {
    match format {
        OutputFormat::Png => InputFormat::Png,
        OutputFormat::Jpeg => InputFormat::Jpeg,
        OutputFormat::Webp => InputFormat::Webp,
        OutputFormat::Avif => InputFormat::Avif,
        OutputFormat::Svg => InputFormat::Svg,
        OutputFormat::Ico => InputFormat::Ico,
    }
}

/// Lance toutes les vérifications et écrit le compte rendu dans `out` ; vrai si tout passe.
pub fn run(out: &mut impl Write) -> bool {
    let dir = std::env::temp_dir().join(format!("rutile-self-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    if let Err(err) = fs::create_dir_all(&dir) {
        let _ = writeln!(out, "ÉCHEC  dossier de test impossible : {err}");
        return false;
    }
    let _ = writeln!(
        out,
        "Rutile : vérification des conversions dans {}",
        dir.display()
    );

    let mut report = Report { out, failures: 0 };
    images(&dir, &mut report);
    videos(&dir, &mut report);

    let failures = report.failures;
    let _ = fs::remove_dir_all(&dir);
    if failures == 0 {
        let _ = writeln!(report.out, "Tout est bon.");
    } else {
        let _ = writeln!(report.out, "{failures} vérification(s) en échec.");
    }
    failures == 0
}

struct Report<'a, W: Write> {
    out: &'a mut W,
    failures: usize,
}

impl<W: Write> Report<'_, W> {
    fn check(&mut self, label: &str, started: Instant, result: Result<String, String>) {
        let elapsed = started.elapsed().as_millis();
        let line = match result {
            Ok(detail) => format!("ok     {label:<14} {detail} ({elapsed} ms)"),
            Err(err) => {
                self.failures += 1;
                format!("ÉCHEC  {label:<14} {err}")
            }
        };
        let _ = writeln!(self.out, "{line}");
    }
}

fn images(dir: &Path, report: &mut Report<impl Write>) {
    // Un PNG transparent et une photo JPEG : le PNG se convertit vers tout sauf lui-même
    let png = dir.join("exemple.png");
    let jpeg = dir.join("photo.jpg");
    let samples = sample_png(&png).and_then(|()| sample_jpeg(&jpeg));
    if let Err(err) = samples {
        report.check("images", Instant::now(), Err(err));
        return;
    }
    for format in OutputFormat::ALL {
        let started = Instant::now();
        let source = if format == OutputFormat::Png {
            &jpeg
        } else {
            &png
        };
        let result = crate::convert(source, format, &Quality::default())
            .map_err(|err| err.to_string())
            .and_then(|conversion| validate_image(&conversion.output, format));
        report.check(&format!("image {}", format.extension()), started, result);
    }
}

fn sample_png(path: &Path) -> Result<(), String> {
    let image = RgbaImage::from_fn(96, 64, |x, y| {
        let alpha = if x < 16 && y < 16 { 0 } else { 255 };
        Rgba([(x * 2) as u8, (y * 3) as u8, 180, alpha])
    });
    DynamicImage::ImageRgba8(image)
        .save_with_format(path, ImageFormat::Png)
        .map_err(|err| format!("exemple PNG impossible : {err}"))
}

fn sample_jpeg(path: &Path) -> Result<(), String> {
    let image = RgbImage::from_fn(96, 64, |x, y| Rgb([200, (x * 2) as u8, (y * 3) as u8]));
    DynamicImage::ImageRgb8(image)
        .save_with_format(path, ImageFormat::Jpeg)
        .map_err(|err| format!("exemple JPEG impossible : {err}"))
}

/// Le fichier produit est bien du format demandé et se relit sans erreur.
fn validate_image(path: &Path, format: OutputFormat) -> Result<String, String> {
    let found = crate::detect_format(path).map_err(|err| err.to_string())?;
    if found != expected(format) {
        return Err(format!("format lu : {found:?}"));
    }
    let bytes = fs::read(path).map_err(|err| err.to_string())?;
    let image = decode::decode(&bytes, found).map_err(|err| err.to_string())?;
    if image.width() == 0 || image.height() == 0 {
        return Err("image vide".into());
    }
    Ok(format!(
        "{} × {}, {}",
        image.width(),
        image.height(),
        size(bytes.len())
    ))
}

fn videos(dir: &Path, report: &mut Report<impl Write>) {
    let started = Instant::now();
    let Some(ffmpeg) = video::ffmpeg() else {
        report.check("FFmpeg", started, Err("introuvable".into()));
        return;
    };
    report.check("FFmpeg", started, Ok(ffmpeg.ffmpeg.display().to_string()));

    // Deux secondes de mire et un son, dans un AVI : aucun format de la roue n'est celui
    // d'origine, et les encodeurs utilisés existent dans tout FFmpeg
    let sample = dir.join("exemple.avi");
    let started = Instant::now();
    let created = video::command(&ffmpeg.ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(["-f", "lavfi", "-i", "testsrc=size=160x120:rate=15"])
        .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100"])
        .args(["-t", "2", "-c:v", "mpeg4", "-c:a", "pcm_s16le"])
        .arg(&sample)
        .output();
    match created {
        Ok(output) if output.status.success() => {}
        Ok(output) => {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let err = if err.is_empty() {
                format!("FFmpeg s'est arrêté ({})", output.status)
            } else {
                err
            };
            report.check("vidéo exemple", started, Err(err));
            return;
        }
        Err(err) => {
            report.check("vidéo exemple", started, Err(err.to_string()));
            return;
        }
    }

    for format in VideoFormat::ALL {
        let started = Instant::now();
        let result = video::convert_video(&sample, format, |_| {})
            .map_err(|err| err.to_string())
            .and_then(|conversion| validate_video(ffmpeg, &conversion.output, format));
        report.check(&format!("vidéo {}", format.extension()), started, result);
    }
}

/// FFmpeg relit tout le fichier sans erreur, et y trouve l'image (ou le son pour le MP3).
fn validate_video(
    ffmpeg: &video::Ffmpeg,
    path: &PathBuf,
    format: VideoFormat,
) -> Result<String, String> {
    let decoded = video::command(&ffmpeg.ffmpeg)
        .args(["-hide_banner", "-v", "error", "-i"])
        .arg(path)
        .args(["-f", "null", "-"])
        .output()
        .map_err(|err| err.to_string())?;
    let errors = String::from_utf8_lossy(&decoded.stderr);
    if !decoded.status.success() || !errors.trim().is_empty() {
        return Err(format!("illisible : {}", errors.trim()));
    }
    let probe = ffmpeg.probe_own_output(path);
    let wanted = if format == VideoFormat::Mp3 {
        probe.has_audio
    } else {
        probe.has_video
    };
    if !wanted {
        return Err("piste attendue absente".into());
    }
    let bytes = fs::metadata(path).map_err(|err| err.to_string())?.len();
    let duration = probe
        .duration
        .map(|seconds| format!("{seconds:.1} s, "))
        .unwrap_or_default();
    Ok(format!("{duration}{}", size(bytes as usize)))
}

fn size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes} o")
    } else {
        format!("{:.1} Ko", bytes as f64 / 1024.0)
    }
}
