//! Vidéos : la conversion est confiée au FFmpeg installé sur le système.

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;

use serde::{Deserialize, Serialize};

use crate::{ConvertError, InputFormat, output};

/// Ce que FFmpeg peut ouvrir pour lire une vidéo : des fichiers locaux, et seulement les
/// conteneurs que la roue accepte (MP4 et MOV, MKV et WebM, AVI, WMV, FLV, MPEG-TS, MPEG,
/// Ogg, GIF). Un fichier piégé, comme une liste de lecture HLS renommée en `.ts`, ne peut
/// ainsi ni faire lire d'autres fichiers ou une adresse en ligne, ni passer par un des
/// nombreux autres lecteurs de format de FFmpeg. Options d'entrée, avant `-i`.
const INPUT_LIMITS: [&str; 4] = [
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    "mov,matroska,avi,asf,flv,mpegts,mpeg,mpegvideo,ogg,gif",
];

/// Formats proposés sur la roue en mode Vidéo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoFormat {
    Mp4,
    Webm,
    Mov,
    Mkv,
    Gif,
    Mp3,
}

impl VideoFormat {
    pub const ALL: [VideoFormat; 6] = [
        VideoFormat::Mp4,
        VideoFormat::Webm,
        VideoFormat::Mov,
        VideoFormat::Mkv,
        VideoFormat::Gif,
        VideoFormat::Mp3,
    ];

    pub fn extension(self) -> &'static str {
        match self {
            VideoFormat::Mp4 => "mp4",
            VideoFormat::Webm => "webm",
            VideoFormat::Mov => "mov",
            VideoFormat::Mkv => "mkv",
            VideoFormat::Gif => "gif",
            VideoFormat::Mp3 => "mp3",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            VideoFormat::Mp4 => "MP4",
            VideoFormat::Webm => "WebM",
            VideoFormat::Mov => "MOV",
            VideoFormat::Mkv => "MKV",
            VideoFormat::Gif => "GIF",
            VideoFormat::Mp3 => "MP3",
        }
    }
}

impl std::fmt::Display for VideoFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.label())
    }
}

/// Conteneur d'une vidéo en entrée, reconnu d'après son contenu.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoInput {
    Mp4,
    Mov,
    Webm,
    Mkv,
    Avi,
    /// Lisible par FFmpeg, sans équivalent sur la roue (WMV, FLV, MPEG-TS…).
    Other,
}

/// Marques ISO BMFF qui désignent une image ou un son, pas une vidéo.
const NOT_VIDEO_BRANDS: [&[u8; 4]; 10] = [
    b"avif", b"avis", b"heic", b"heix", b"heim", b"heis", b"mif1", b"msf1", b"M4A ", b"M4B ",
];

const OTHER_EXTENSIONS: [&str; 11] = [
    "wmv", "asf", "flv", "ts", "mts", "m2ts", "mpg", "mpeg", "3gp", "3g2", "ogv",
];

impl VideoInput {
    pub fn detect(header: &[u8], path: &Path) -> Option<Self> {
        if header.len() >= 12 && &header[4..8] == b"ftyp" {
            let brand: &[u8; 4] = header[8..12].try_into().ok()?;
            if NOT_VIDEO_BRANDS.contains(&brand) {
                return None;
            }
            return Some(if brand == b"qt  " {
                VideoInput::Mov
            } else {
                VideoInput::Mp4
            });
        }
        if header.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
            let start = &header[..header.len().min(64)];
            let webm = start.windows(4).any(|window| window == b"webm");
            return Some(if webm {
                VideoInput::Webm
            } else {
                VideoInput::Mkv
            });
        }
        if header.len() >= 12 && header.starts_with(b"RIFF") && &header[8..12] == b"AVI " {
            return Some(VideoInput::Avi);
        }
        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_ascii_lowercase)?;
        if extension == "m4v" {
            return Some(VideoInput::Mp4);
        }
        OTHER_EXTENSIONS
            .contains(&extension.as_str())
            .then_some(VideoInput::Other)
    }

    /// Le même format sur la roue, grisé car la conversion n'aurait pas de sens.
    pub fn as_output(self) -> Option<VideoFormat> {
        match self {
            VideoInput::Mp4 => Some(VideoFormat::Mp4),
            VideoInput::Mov => Some(VideoFormat::Mov),
            VideoInput::Webm => Some(VideoFormat::Webm),
            VideoInput::Mkv => Some(VideoFormat::Mkv),
            VideoInput::Avi | VideoInput::Other => None,
        }
    }
}

/// Vidéo reconnue d'après ses premiers octets (un GIF animé compte aussi).
pub fn detect_video(path: &Path) -> Option<VideoInput> {
    let mut header = Vec::with_capacity(InputFormat::HEADER_LEN);
    File::open(path)
        .and_then(|file| {
            file.take(InputFormat::HEADER_LEN as u64)
                .read_to_end(&mut header)
        })
        .ok()?;
    VideoInput::detect(&header, path)
}

#[derive(Debug, thiserror::Error)]
pub enum VideoError {
    #[error(
        "FFmpeg est introuvable : installez-le pour convertir des vidéos ({}).",
        install_hint()
    )]
    FfmpegMissing,
    #[error("Le fichier est déjà au format {0}.")]
    SameFormat(VideoFormat),
    #[error("Cette vidéo n'a pas de son à extraire.")]
    NoAudio,
    #[error("Cette vidéo n'a pas d'image.")]
    NoVideo,
    #[error("Votre FFmpeg ne sait pas encoder en {0}.")]
    MissingEncoder(VideoFormat),
    #[error("Ce fichier n'est pas dans un format vidéo que Rutile accepte.")]
    UnsupportedInput,
    #[error("Échec de FFmpeg ({0}).")]
    Failed(String),
    #[error(transparent)]
    Output(#[from] ConvertError),
}

/// Commande d'installation de FFmpeg, selon le système.
pub fn install_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "brew install ffmpeg"
    } else if cfg!(windows) {
        "winget install Gyan.FFmpeg"
    } else {
        // Court : il s'affiche aussi au centre de la roue
        "paquet ffmpeg (apt, dnf ou brew)"
    }
}

/// FFmpeg embarqué avec l'app (sidecar Tauri), installé à côté de son exécutable. Un nom
/// propre à Rutile évite d'écraser le `ffmpeg` du système dans `/usr/bin` (paquets Linux).
pub const BUNDLED_FFMPEG: &str = "rutile-ffmpeg";

/// FFmpeg trouvé sur la machine, avec la liste de ses encodeurs.
#[derive(Debug)]
pub struct Ffmpeg {
    pub(crate) ffmpeg: PathBuf,
    ffprobe: Option<PathBuf>,
    encoders: String,
}

/// Cherché à chaque appel tant qu'il manque, puis gardé : installer FFmpeg pendant que Rutile
/// tourne suffit. Ordre : `RUTILE_FFMPEG`, celui embarqué avec l'app, puis celui du système.
pub fn ffmpeg() -> Option<&'static Ffmpeg> {
    static FOUND: OnceLock<Ffmpeg> = OnceLock::new();
    if let Some(found) = FOUND.get() {
        return Some(found);
    }
    let ffmpeg = std::env::var_os("RUTILE_FFMPEG")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(bundled_ffmpeg)
        .or_else(|| find_program("ffmpeg"))?;
    let ffprobe = ffmpeg
        .parent()
        .map(|dir| dir.join(executable("ffprobe")))
        .filter(|path| path.is_file())
        .or_else(|| find_program("ffprobe"));
    let encoders = command(&ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default();
    Some(FOUND.get_or_init(|| Ffmpeg {
        ffmpeg,
        ffprobe,
        encoders,
    }))
}

fn bundled_ffmpeg() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.join(executable(BUNDLED_FFMPEG));
    path.is_file().then_some(path)
}

fn executable(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Une app lancée depuis le Finder n'hérite pas du PATH du terminal : on regarde aussi là où
/// Homebrew, MacPorts, winget et Linuxbrew installent FFmpeg.
fn find_program(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "macos") {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"].map(PathBuf::from));
    } else if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(
                PathBuf::from(local)
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links"),
            );
        }
        dirs.push(PathBuf::from(r"C:\ffmpeg\bin"));
    } else {
        dirs.extend(
            [
                "/usr/bin",
                "/usr/local/bin",
                "/home/linuxbrew/.linuxbrew/bin",
            ]
            .map(PathBuf::from),
        );
        if let Some(home) = &home {
            dirs.push(home.join(".linuxbrew/bin"));
        }
    }
    let file = executable(name);
    dirs.into_iter()
        .map(|dir| dir.join(&file))
        .find(|path| path.is_file())
}

/// Sous Windows, une console s'ouvrirait le temps de la conversion sans ce réglage.
pub(crate) fn command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.stdin(Stdio::null());
    command
}

impl Ffmpeg {
    fn has_encoder(&self, name: &str) -> bool {
        self.encoders
            .lines()
            .any(|line| line.split_whitespace().nth(1) == Some(name))
    }

    fn first_encoder<'a>(&self, names: &[&'a str]) -> Option<&'a str> {
        names.iter().copied().find(|name| self.has_encoder(name))
    }

    /// Durée en secondes et présence de pistes, lues par ffprobe s'il est là, sinon dans ce
    /// qu'affiche FFmpeg (le FFmpeg embarqué vient sans ffprobe).
    /// Chemin de l'exécutable utilisé.
    pub fn path(&self) -> &Path {
        &self.ffmpeg
    }

    pub(crate) fn probe(&self, input: &Path) -> Probe {
        self.probe_limited(input, &INPUT_LIMITS)
    }

    /// Comme `probe`, sans les limites des fichiers de l'utilisateur : pour relire un fichier
    /// que Rutile vient de produire, un MP3 compris.
    pub(crate) fn probe_own_output(&self, output: &Path) -> Probe {
        self.probe_limited(output, &[])
    }

    fn probe_limited(&self, input: &Path, limits: &[&str]) -> Probe {
        let Some(ffprobe) = &self.ffprobe else {
            return self.probe_with_ffmpeg(input, limits);
        };
        let output = command(ffprobe)
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration:stream=codec_type",
                "-of",
                "default=noprint_wrappers=1",
            ])
            .args(limits)
            .arg(input)
            .output();
        let Ok(output) = output else {
            return Probe::default();
        };
        let text = String::from_utf8_lossy(&output.stdout);
        Probe {
            known: output.status.success(),
            duration: text
                .lines()
                .find_map(|line| line.strip_prefix("duration="))
                .and_then(|value| value.trim().parse::<f64>().ok())
                .filter(|seconds| *seconds > 0.0),
            has_video: text.lines().any(|line| line == "codec_type=video"),
            has_audio: text.lines().any(|line| line == "codec_type=audio"),
        }
    }

    /// `ffmpeg -i` sans fichier de sortie décrit l'entrée sur stderr, puis s'arrête en erreur.
    fn probe_with_ffmpeg(&self, input: &Path, limits: &[&str]) -> Probe {
        let output = command(&self.ffmpeg)
            .arg("-hide_banner")
            .args(limits)
            .arg("-i")
            .arg(input)
            .output();
        match output {
            Ok(output) => parse_ffmpeg_info(&String::from_utf8_lossy(&output.stderr)),
            Err(_) => Probe::default(),
        }
    }

    /// Arguments d'encodage ; les vidéos aux dimensions impaires sont arrondies pour le H.264.
    fn arguments(&self, format: VideoFormat) -> Result<Vec<String>, VideoError> {
        let missing = || VideoError::MissingEncoder(format);
        let even = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
        let args: Vec<&str> = match format {
            VideoFormat::Mp4 | VideoFormat::Mov => {
                let encoder = self
                    // Jamais h264_mf : Media Foundation manque aux éditions N de Windows
                    .first_encoder(&["libx264", "h264_videotoolbox", "libopenh264"])
                    .ok_or_else(missing)?;
                let quality: &[&str] = match encoder {
                    "libx264" => &["-preset", "medium", "-crf", "23"],
                    "h264_videotoolbox" => &["-q:v", "60"],
                    _ => &["-b:v", "6M"],
                };
                let mut args = vec![
                    "-map", "0:v:0", "-map", "0:a:0?", "-vf", even, "-c:v", encoder,
                ];
                args.extend_from_slice(quality);
                args.extend_from_slice(&["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k"]);
                args.extend_from_slice(&["-movflags", "+faststart"]);
                args
            }
            VideoFormat::Webm => {
                let (video, quality): (&str, &[&str]) = if self.has_encoder("libvpx-vp9") {
                    (
                        "libvpx-vp9",
                        &[
                            "-crf",
                            "32",
                            "-b:v",
                            "0",
                            "-row-mt",
                            "1",
                            "-deadline",
                            "good",
                            "-cpu-used",
                            "4",
                        ],
                    )
                } else if self.has_encoder("libvpx") {
                    ("libvpx", &["-crf", "10", "-b:v", "2M"])
                } else {
                    return Err(missing());
                };
                let audio = self
                    .first_encoder(&["libopus", "libvorbis"])
                    .ok_or_else(missing)?;
                let mut args = vec!["-map", "0:v:0", "-map", "0:a:0?", "-c:v", video];
                args.extend_from_slice(quality);
                args.extend_from_slice(&["-c:a", audio, "-b:a", "128k"]);
                args
            }
            // Le MKV accepte tous les codecs : on recopie les pistes sans réencoder
            VideoFormat::Mkv => vec!["-map", "0:v?", "-map", "0:a?", "-c", "copy"],
            // Palette calculée sur la vidéo pour un GIF fidèle, réduit à 640 px et 12 images/s
            VideoFormat::Gif => vec![
                "-map",
                "0:v:0",
                "-vf",
                "fps=12,scale='min(640,iw)':-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
                "-loop",
                "0",
            ],
            VideoFormat::Mp3 => {
                if !self.has_encoder("libmp3lame") {
                    return Err(missing());
                }
                vec!["-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-q:a", "2"]
            }
        };
        Ok(args.into_iter().map(String::from).collect())
    }
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct Probe {
    /// ffprobe (ou FFmpeg) a pu lire le fichier.
    pub(crate) known: bool,
    pub(crate) duration: Option<f64>,
    pub(crate) has_video: bool,
    pub(crate) has_audio: bool,
}

/// Lit la durée (« Duration: 00:01:02.50, ») et les pistes (« Stream #0:0: Video: … »)
/// dans la description d'un fichier par FFmpeg.
fn parse_ffmpeg_info(text: &str) -> Probe {
    let lines = || text.lines().map(str::trim);
    let duration = lines()
        .find_map(|line| line.strip_prefix("Duration: "))
        .and_then(|rest| rest.split(',').next())
        .and_then(parse_timestamp)
        .filter(|seconds| *seconds > 0.0);
    let streams = || lines().filter(|line| line.starts_with("Stream #"));
    Probe {
        known: text.contains("Input #0"),
        duration,
        has_video: streams().any(|line| line.contains(": Video:")),
        has_audio: streams().any(|line| line.contains(": Audio:")),
    }
}

/// « 01:02:03.50 » en secondes.
fn parse_timestamp(value: &str) -> Option<f64> {
    let mut parts = value.trim().split(':');
    let (hours, minutes, seconds) = (parts.next()?, parts.next()?, parts.next()?);
    Some(
        hours.parse::<f64>().ok()? * 3600.0
            + minutes.parse::<f64>().ok()? * 60.0
            + seconds.parse::<f64>().ok()?,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoConversion {
    pub output: PathBuf,
    pub format: VideoFormat,
}

/// Convertit `input` vers `format` ; `on_progress` reçoit l'avancement de 0 à 1.
/// Bloquant : à appeler hors du thread principal.
pub fn convert_video(
    input: &Path,
    format: VideoFormat,
    mut on_progress: impl FnMut(f64),
) -> Result<VideoConversion, VideoError> {
    let ffmpeg = ffmpeg().ok_or(VideoError::FfmpegMissing)?;
    let source = detect_video(input);
    let same = source.and_then(VideoInput::as_output) == Some(format)
        || (format == VideoFormat::Gif
            && crate::detect_format(input).ok() == Some(InputFormat::Gif));
    if same {
        return Err(VideoError::SameFormat(format));
    }

    let probe = ffmpeg.probe(input);
    if probe.known {
        if format == VideoFormat::Mp3 && !probe.has_audio {
            return Err(VideoError::NoAudio);
        }
        if format != VideoFormat::Mp3 && !probe.has_video {
            return Err(VideoError::NoVideo);
        }
    }
    let arguments = ffmpeg.arguments(format)?;

    // Le nom est réservé (fichier vide), puis FFmpeg l'écrit à la place
    let (output, reserved) = output::reserve(input, format.extension())?;
    drop(reserved);
    let result = run(
        ffmpeg,
        input,
        &arguments,
        &output,
        probe.duration,
        &mut on_progress,
    );
    if result.is_err() {
        let _ = fs::remove_file(&output);
    }
    result.map(|()| VideoConversion { output, format })
}

fn run(
    ffmpeg: &Ffmpeg,
    input: &Path,
    arguments: &[String],
    output: &Path,
    duration: Option<f64>,
    on_progress: &mut impl FnMut(f64),
) -> Result<(), VideoError> {
    let mut child = command(&ffmpeg.ffmpeg)
        .args([
            "-hide_banner",
            "-nostdin",
            "-y",
            "-loglevel",
            "error",
            "-nostats",
        ])
        .args(["-progress", "pipe:1"])
        .args(INPUT_LIMITS)
        .arg("-i")
        .arg(input)
        .args(arguments)
        .arg(output)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| VideoError::Failed(err.to_string()))?;

    // Les erreurs sont lues à part, sinon un tampon plein bloquerait FFmpeg
    let stderr = child.stderr.take();
    let errors = thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });

    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Some(micros) = line.strip_prefix("out_time_us=") else {
                continue;
            };
            if let (Ok(micros), Some(duration)) = (micros.trim().parse::<f64>(), duration) {
                on_progress((micros / 1_000_000.0 / duration).clamp(0.0, 1.0));
            }
        }
    }

    let status = child
        .wait()
        .map_err(|err| VideoError::Failed(err.to_string()))?;
    let errors = errors.join().unwrap_or_default();
    if status.success() {
        on_progress(1.0);
        return Ok(());
    }
    if errors.contains("not on whitelist") {
        return Err(VideoError::UnsupportedInput);
    }
    let last_line = errors
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("erreur inconnue");
    Err(VideoError::Failed(last_line.trim().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detect(header: &[u8], name: &str) -> Option<VideoInput> {
        VideoInput::detect(header, Path::new(name))
    }

    fn ftyp(brand: &[u8; 4]) -> Vec<u8> {
        let mut header = vec![0, 0, 0, 0x20];
        header.extend_from_slice(b"ftyp");
        header.extend_from_slice(brand);
        header.resize(32, 0);
        header
    }

    #[test]
    fn reconnait_les_conteneurs_par_leur_contenu() {
        assert_eq!(detect(&ftyp(b"isom"), "a.bin"), Some(VideoInput::Mp4));
        assert_eq!(detect(&ftyp(b"qt  "), "a.bin"), Some(VideoInput::Mov));
        let mut webm = vec![0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84];
        webm.extend_from_slice(b"webm");
        assert_eq!(detect(&webm, "a.bin"), Some(VideoInput::Webm));
        let mut mkv = vec![0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88];
        mkv.extend_from_slice(b"matroska");
        assert_eq!(detect(&mkv, "a.bin"), Some(VideoInput::Mkv));
        assert_eq!(
            detect(b"RIFF\0\0\0\0AVI LIST", "a.bin"),
            Some(VideoInput::Avi)
        );
    }

    #[test]
    fn les_images_et_les_sons_ne_sont_pas_des_videos() {
        assert_eq!(detect(&ftyp(b"avif"), "photo.avif"), None);
        assert_eq!(detect(&ftyp(b"heic"), "photo.heic"), None);
        assert_eq!(detect(&ftyp(b"M4A "), "chanson.m4a"), None);
        assert_eq!(detect(b"\x89PNG\r\n\x1a\n", "image.png"), None);
    }

    #[test]
    fn l_extension_complete_quand_le_contenu_ne_suffit_pas() {
        assert_eq!(detect(&[0x47; 16], "film.ts"), Some(VideoInput::Other));
        assert_eq!(detect(&[0; 16], "clip.m4v"), Some(VideoInput::Mp4));
        assert_eq!(detect(&[0; 16], "notes.txt"), None);
    }

    #[test]
    fn lit_la_description_d_un_fichier_par_ffmpeg() {
        let text = "Input #0, avi, from 'exemple.avi':\n  Duration: 00:01:02.50, start: 0.000000, bitrate: 2000 kb/s\n  Stream #0:0: Video: mpeg4 (FMP4), yuv420p, 160x120, 15 fps\n  Stream #0:1: Audio: pcm_s16le, 44100 Hz, mono\nAt least one output file must be specified";
        let probe = parse_ffmpeg_info(text);
        assert_eq!(
            probe,
            Probe {
                known: true,
                duration: Some(62.5),
                has_video: true,
                has_audio: true,
            }
        );
        let silent = parse_ffmpeg_info("Input #0, gif\n  Duration: N/A\n  Stream #0:0: Video: gif");
        assert_eq!(silent.duration, None);
        assert!(!silent.has_audio);
    }

    #[test]
    fn le_format_d_origine_est_reconnu() {
        assert_eq!(VideoInput::Mov.as_output(), Some(VideoFormat::Mov));
        assert_eq!(VideoInput::Avi.as_output(), None);
    }
}
