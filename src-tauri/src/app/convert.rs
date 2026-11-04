//! Commandes de conversion appelées par la roue, et texte des notifications.

use std::path::{Path, PathBuf};

use converter::{Conversion, ConvertError, InputFormat, OutputFormat, Quality};
use serde::Serialize;
use tauri::{AppHandle, Runtime};

use super::notify::{self, Action, Message};
use super::settings;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    path: PathBuf,
    name: String,
    /// `None` si ce n'est pas une image prise en charge.
    format: Option<InputFormat>,
}

/// Lit le format réel de chaque fichier, pour griser le format d'origine sur la roue.
pub fn inspect(paths: Vec<PathBuf>) -> Vec<FileInfo> {
    paths
        .into_iter()
        .map(|path| FileInfo {
            name: file_name(&path),
            format: converter::detect_format(&path).ok(),
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

/// Convertit sur un thread à part, puis prévient par une notification.
#[tauri::command]
pub async fn convert_files<R: Runtime>(
    app: AppHandle<R>,
    paths: Vec<PathBuf>,
    format: OutputFormat,
) -> Result<Outcome, String> {
    let quality = settings::current(&app).quality();
    let report =
        tauri::async_runtime::spawn_blocking(move || Report::run(&paths, format, &quality))
            .await
            .map_err(|err| err.to_string())?;
    notify::show(&app, report.message());
    Ok(Outcome {
        converted: report.converted.len(),
        failed: report.failed.len(),
    })
}

pub struct Report {
    format: OutputFormat,
    converted: Vec<Conversion>,
    /// Fichiers déjà dans le format demandé, quand plusieurs fichiers sont déposés.
    skipped: usize,
    failed: Vec<(String, ConvertError)>,
}

impl Report {
    fn run(paths: &[PathBuf], format: OutputFormat, quality: &Quality) -> Report {
        let mut report = Report {
            format,
            converted: Vec::new(),
            skipped: 0,
            failed: Vec::new(),
        };
        for path in paths {
            match converter::convert(path, format, quality) {
                Ok(conversion) => report.converted.push(conversion),
                Err(ConvertError::SameFormat(_)) if paths.len() > 1 => report.skipped += 1,
                Err(err) => report.failed.push((file_name(path), err)),
            }
        }
        report
    }

    fn message(&self) -> Message {
        let format = self.format.label();
        let done = self.converted.len();
        let failed = self.failed.len();

        let title = match (done, failed) {
            (0, 0) => "Rien à convertir".to_string(),
            (0, 1) => "Conversion impossible".to_string(),
            (0, _) => format!("Conversion impossible pour {failed} fichiers"),
            (1, 0) => format!("Image convertie en {format}"),
            (_, 0) => format!("{done} images converties en {format}"),
            _ => format!(
                "{done} {} en {format}, {failed} {}",
                plural(done, "image convertie", "images converties"),
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
        if self.converted.iter().any(|c| c.approximate) {
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
            action: (!self.converted.is_empty())
                .then(|| Action::Reveal(self.converted.iter().map(|c| c.output.clone()).collect())),
        }
    }
}

fn list_names(conversions: &[Conversion]) -> String {
    const SHOWN: usize = 3;
    let names: Vec<String> = conversions
        .iter()
        .take(SHOWN)
        .map(|c| file_name(&c.output))
        .collect();
    let rest = conversions.len().saturating_sub(SHOWN);
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

    fn conversion(name: &str, format: OutputFormat) -> Conversion {
        Conversion {
            output: PathBuf::from("/images").join(name),
            format,
            approximate: format == OutputFormat::Svg,
        }
    }

    fn report(converted: Vec<Conversion>, skipped: usize, failed: Vec<&str>) -> Report {
        Report {
            format: OutputFormat::Webp,
            converted,
            skipped,
            failed: failed
                .into_iter()
                .map(|name| (name.to_string(), ConvertError::UnsupportedFormat))
                .collect(),
        }
    }

    #[test]
    fn une_image_convertie() {
        let message = report(
            vec![conversion("photo.webp", OutputFormat::Webp)],
            0,
            vec![],
        )
        .message();
        assert_eq!(message.title, "Image convertie en WebP");
        assert_eq!(message.body, "photo.webp");
        assert_eq!(
            message.action,
            Some(Action::Reveal(vec![PathBuf::from("/images/photo.webp")]))
        );
    }

    #[test]
    fn la_vectorisation_est_signalee() {
        let mut report = report(vec![conversion("logo.svg", OutputFormat::Svg)], 0, vec![]);
        report.format = OutputFormat::Svg;
        let message = report.message();
        assert_eq!(message.title, "Image convertie en SVG");
        assert!(message.body.contains("Vectorisation approximative"));
    }

    #[test]
    fn plusieurs_images_et_fichiers_ignores() {
        let converted = ["a.webp", "b.webp", "c.webp", "d.webp"]
            .map(|name| conversion(name, OutputFormat::Webp))
            .to_vec();
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
        let message = report(
            vec![conversion("a.webp", OutputFormat::Webp)],
            0,
            vec!["x.txt", "y.txt"],
        )
        .message();
        assert_eq!(message.title, "1 image convertie en WebP, 2 échecs");
        assert!(message.body.starts_with("x.txt : "));
        assert!(message.body.ends_with("… et 1 autre(s)."));
        assert!(matches!(message.action, Some(Action::Reveal(paths)) if paths.len() == 1));
    }
}
