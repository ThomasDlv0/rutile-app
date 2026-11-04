//! Commandes de conversion appelées par la roue, et texte des notifications.

use std::path::{Path, PathBuf};

use converter::video::{self, VideoError, VideoFormat, VideoInput};
use converter::{ConvertError, InputFormat, OutputFormat, Quality};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use super::notify::{self, Action, Message};
use super::settings;
use super::wheel::WHEEL_LABEL;

/// Avancement d'une conversion vidéo, de 0 à 1, pour le centre de la roue.
const PROGRESS_EVENT: &str = "wheel://progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    path: PathBuf,
    name: String,
    /// `None` si ce n'est pas une image prise en charge.
    format: Option<InputFormat>,
    /// `None` si ce n'est pas une vidéo reconnue.
    video: Option<VideoInput>,
}

/// Lit le format réel de chaque fichier, pour griser le format d'origine sur la roue.
pub fn inspect(paths: Vec<PathBuf>) -> Vec<FileInfo> {
    paths
        .into_iter()
        .map(|path| FileInfo {
            name: file_name(&path),
            format: converter::detect_format(&path).ok(),
            video: video::detect_video(&path),
            path,
        })
        .collect()
}

#[tauri::command]
pub async fn inspect_files(paths: Vec<PathBuf>) -> Vec<FileInfo> {
    tauri::async_runtime::spawn_blocking(move || inspect(paths))
        .await
        .unwrap_or_default()
}

/// Bilan renvoyé à la roue, qui l'affiche brièvement avant de se fermer.
#[derive(Debug, Serialize)]
pub struct Outcome {
    converted: usize,
    failed: usize,
}

impl From<&Report> for Outcome {
    fn from(report: &Report) -> Self {
        Outcome {
            converted: report.converted.len(),
            failed: report.failed.len(),
        }
    }
}

/// Convertit sur un thread à part, puis prévient par une notification.
#[tauri::command]
pub async fn convert_files<R: Runtime>(
    app: AppHandle<R>,
    paths: Vec<PathBuf>,
    format: OutputFormat,
) -> Result<Outcome, String> {
    let quality = settings::current(&app).quality();
    let report =
        tauri::async_runtime::spawn_blocking(move || Report::images(&paths, format, &quality))
            .await
            .map_err(|err| err.to_string())?;
    notify::show(&app, report.message());
    Ok(Outcome::from(&report))
}

/// Comme `convert_files`, avec FFmpeg ; l'avancement est envoyé à la roue.
#[tauri::command]
pub async fn convert_videos<R: Runtime>(
    app: AppHandle<R>,
    paths: Vec<PathBuf>,
    format: VideoFormat,
) -> Result<Outcome, String> {
    let handle = app.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let total = paths.len().max(1) as f64;
        let mut sent = -1.0;
        Report::videos(&paths, format, |index, fraction| {
            let overall = (index as f64 + fraction) / total;
            // Un envoi par point de pourcentage suffit à l'affichage
            if overall - sent >= 0.01 || overall >= 1.0 {
                sent = overall;
                let _ = handle.emit_to(WHEEL_LABEL, PROGRESS_EVENT, overall);
            }
        })
    })
    .await
    .map_err(|err| err.to_string())?;
    notify::show(&app, report.message());
    Ok(Outcome::from(&report))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSupport {
    available: bool,
    /// Commande d'installation de FFmpeg pour ce système.
    install_hint: &'static str,
}

#[tauri::command]
pub async fn video_support() -> VideoSupport {
    let available = tauri::async_runtime::spawn_blocking(|| video::ffmpeg().is_some())
        .await
        .unwrap_or(false);
    VideoSupport {
        available,
        install_hint: video::install_hint(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Image,
    Video,
    /// Son extrait d'une vidéo (MP3).
    Sound,
}

impl Kind {
    /// Singulier en début de titre, pluriel, singulier en milieu de phrase.
    fn nouns(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Kind::Image => ("Image convertie", "images converties", "image convertie"),
            Kind::Video => ("Vidéo convertie", "vidéos converties", "vidéo convertie"),
            Kind::Sound => ("Son extrait", "sons extraits", "son extrait"),
        }
    }
}

pub struct Report {
    kind: Kind,
    label: &'static str,
    /// Fichiers produits, avec vrai pour une vectorisation approximative.
    converted: Vec<(PathBuf, bool)>,
    /// Fichiers déjà dans le format demandé, quand plusieurs fichiers sont déposés.
    skipped: usize,
    failed: Vec<(String, String)>,
}

impl Report {
    fn new(kind: Kind, label: &'static str) -> Report {
        Report {
            kind,
            label,
            converted: Vec::new(),
            skipped: 0,
            failed: Vec::new(),
        }
    }

    fn images(paths: &[PathBuf], format: OutputFormat, quality: &Quality) -> Report {
        let mut report = Report::new(Kind::Image, format.label());
        for path in paths {
            match converter::convert(path, format, quality) {
                Ok(conversion) => report
                    .converted
                    .push((conversion.output, conversion.approximate)),
                Err(ConvertError::SameFormat(_)) if paths.len() > 1 => report.skipped += 1,
                Err(err) => report.failed.push((file_name(path), err.to_string())),
            }
        }
        report
    }

    /// `progress` reçoit le numéro du fichier et son avancement de 0 à 1.
    fn videos(
        paths: &[PathBuf],
        format: VideoFormat,
        mut progress: impl FnMut(usize, f64),
    ) -> Report {
        let kind = if format == VideoFormat::Mp3 {
            Kind::Sound
        } else {
            Kind::Video
        };
        let mut report = Report::new(kind, format.label());
        for (index, path) in paths.iter().enumerate() {
            match video::convert_video(path, format, |fraction| progress(index, fraction)) {
                Ok(conversion) => report.converted.push((conversion.output, false)),
                Err(VideoError::SameFormat(_)) if paths.len() > 1 => report.skipped += 1,
                Err(err) => report.failed.push((file_name(path), err.to_string())),
            }
        }
        report
    }

    fn message(&self) -> Message {
        let format = self.label;
        let (one, many, one_lower) = self.kind.nouns();
        let done = self.converted.len();
        let failed = self.failed.len();

        let title = match (done, failed) {
            (0, 0) => "Rien à convertir".to_string(),
            (0, 1) => "Conversion impossible".to_string(),
            (0, _) => format!("Conversion impossible pour {failed} fichiers"),
            (1, 0) => format!("{one} en {format}"),
            (_, 0) => format!("{done} {many} en {format}"),
            _ => format!(
                "{done} {} en {format}, {failed} {}",
                plural(done, one_lower, many),
                plural(failed, "échec", "échecs")
            ),
        };

        let mut lines = Vec::new();
        if let Some((name, err)) = self.failed.first() {
            lines.push(format!("{name} : {err}"));
            if failed > 1 {
                lines.push(format!("… et {} autre(s).", failed - 1));
            }
        } else if done > 0 {
            lines.push(list_names(&self.converted));
        }
        if self.converted.iter().any(|(_, approximate)| *approximate) {
            lines.push("Vectorisation approximative de l'image d'origine.".into());
        }
        if self.skipped > 0 {
            lines.push(format!(
                "{} déjà en {format}, {}.",
                plural(
                    self.skipped,
                    "1 fichier",
                    &format!("{} fichiers", self.skipped)
                ),
                plural(self.skipped, "ignoré", "ignorés")
            ));
        }

        Message {
            title,
            body: lines.join("\n"),
            action: (!self.converted.is_empty()).then(|| {
                Action::Reveal(
                    self.converted
                        .iter()
                        .map(|(path, _)| path.clone())
                        .collect(),
                )
            }),
        }
    }
}

fn list_names(converted: &[(PathBuf, bool)]) -> String {
    const SHOWN: usize = 3;
    let names: Vec<String> = converted
        .iter()
        .take(SHOWN)
        .map(|(path, _)| file_name(path))
        .collect();
    let rest = converted.len().saturating_sub(SHOWN);
    if rest == 0 {
        names.join(", ")
    } else {
        format!("{} et {rest} autre(s)", names.join(", "))
    }
}

fn plural<'a>(count: usize, one: &'a str, many: &'a str) -> &'a str {
    if count > 1 { many } else { one }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn done(name: &str) -> (PathBuf, bool) {
        (PathBuf::from("/images").join(name), name.ends_with(".svg"))
    }

    fn report(converted: Vec<(PathBuf, bool)>, skipped: usize, failed: Vec<&str>) -> Report {
        let mut report = Report::new(Kind::Image, "WebP");
        report.converted = converted;
        report.skipped = skipped;
        report.failed = failed
            .into_iter()
            .map(|name| {
                (
                    name.to_string(),
                    ConvertError::UnsupportedFormat.to_string(),
                )
            })
            .collect();
        report
    }

    #[test]
    fn une_image_convertie() {
        let message = report(vec![done("photo.webp")], 0, vec![]).message();
        assert_eq!(message.title, "Image convertie en WebP");
        assert_eq!(message.body, "photo.webp");
        assert_eq!(
            message.action,
            Some(Action::Reveal(vec![PathBuf::from("/images/photo.webp")]))
        );
    }

    #[test]
    fn la_vectorisation_est_signalee() {
        let mut report = report(vec![done("logo.svg")], 0, vec![]);
        report.label = "SVG";
        let message = report.message();
        assert_eq!(message.title, "Image convertie en SVG");
        assert!(message.body.contains("Vectorisation approximative"));
    }

    #[test]
    fn plusieurs_images_et_fichiers_ignores() {
        let converted = ["a.webp", "b.webp", "c.webp", "d.webp"].map(done).to_vec();
        let message = report(converted, 2, vec![]).message();
        assert_eq!(message.title, "4 images converties en WebP");
        assert_eq!(
            message.body,
            "a.webp, b.webp, c.webp et 1 autre(s)\n2 fichiers déjà en WebP, ignorés."
        );
    }

    #[test]
    fn un_echec_explique_pourquoi() {
        let message = report(vec![], 0, vec!["notes.txt"]).message();
        assert_eq!(message.title, "Conversion impossible");
        assert!(
            message
                .body
                .starts_with("notes.txt : Ce fichier n'est pas une image")
        );
        assert_eq!(message.action, None);
    }

    #[test]
    fn succes_et_echecs_melanges() {
        let message = report(vec![done("a.webp")], 0, vec!["x.txt", "y.txt"]).message();
        assert_eq!(message.title, "1 image convertie en WebP, 2 échecs");
        assert!(message.body.starts_with("x.txt : "));
        assert!(message.body.ends_with("… et 1 autre(s)."));
        assert!(matches!(message.action, Some(Action::Reveal(paths)) if paths.len() == 1));
    }

    #[test]
    fn les_videos_et_le_son_ont_leurs_propres_mots() {
        let mut videos = Report::new(Kind::Video, "MP4");
        videos.converted = vec![done("a.mp4"), done("b.mp4")];
        assert_eq!(videos.message().title, "2 vidéos converties en MP4");

        let mut sound = Report::new(Kind::Sound, "MP3");
        sound.converted = vec![done("clip.mp3")];
        assert_eq!(sound.message().title, "Son extrait en MP3");
    }
}
