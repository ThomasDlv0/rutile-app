//! Roue Actions : capture, lecture de texte, pipette, fichiers, retouches, vidéos, fenêtres et
//! parts des roues personnalisées. Le résultat s'annonce par une notification, comme les conversions.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use converter::files::{self, RenameStyle};
use converter::retouch::{self, Retouch};
use converter::video::{self, VideoRework};
use platform::capture::{self, CaptureError, CaptureTarget};
use platform::placement::{self, Layout, PlacementError};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

use super::convert::PROGRESS_EVENT;
use super::notify::{self, Action, Message};
use super::settings::{self, CustomPart, PartKind};
use super::wheel::{self, Source, WHEEL_LABEL};

/// Longueur du texte lu rappelée dans la notification.
const TEXT_PREVIEW: usize = 90;
/// Le résultat d'une capture s'affiche d'abord, puis la roue se rouvre sur l'image.
const REOPEN_DELAY: Duration = Duration::from_millis(1100);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColorFormat {
    Hex,
    Rgb,
    Hsl,
}

/// Ce qu'une part de la roue demande de faire.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ActionRequest {
    Capture {
        target: CaptureTarget,
        delay: u32,
    },
    Text,
    Color {
        format: ColorFormat,
    },
    Zip,
    /// Décompresse des archives ZIP.
    Extract,
    ImagesToPdf,
    MergePdfs,
    /// Copie le texte de PDF.
    PdfText,
    /// Copie le texte d'images, lu comme sur une capture.
    ReadText,
    /// Met une image dans le presse-papiers.
    CopyImage,
    /// Copie le chemin des fichiers.
    CopyPaths,
    Rename {
        style: RenameStyle,
    },
    Retouch {
        retouch: Retouch,
    },
    Video {
        rework: VideoRework,
    },
    Place {
        layout: Layout,
    },
    Custom {
        wheel: usize,
        action: usize,
    },
}

/// Lance une action ; `Ok` aussi quand l'utilisateur annule, sans notification.
#[tauri::command]
pub async fn run_action<R: Runtime>(
    app: AppHandle<R>,
    request: ActionRequest,
    paths: Vec<PathBuf>,
) -> Result<(), String> {
    match perform(&app, request, paths).await {
        Ok(Some(message)) => {
            notify::announce(&app, message, true);
            Ok(())
        }
        Ok(None) => Ok(()),
        Err(message) => {
            let reason = message.body.clone();
            // Le réglage s'ouvre tout seul : une notification coupée n'y mènerait jamais
            if let Some(Action::OpenUrl(url)) = &message.action {
                let _ = app.opener().open_url(url, None::<&str>);
            }
            notify::announce(&app, message, false);
            Err(reason)
        }
    }
}

/// Résultat d'une action : son annonce, ou rien si elle a été annulée.
type Done = Result<Option<Message>, Message>;

fn failure(title: impl Into<String>, reason: impl Into<String>) -> Message {
    Message {
        title: title.into(),
        body: reason.into(),
        action: None,
    }
}

/// Raison donnée quand le travail s'est arrêté avant la fin.
fn interrupted() -> String {
    i18n::t("actions.interrupted")
}

/// Le travail se fait hors du thread principal.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tauri::async_runtime::spawn_blocking(work).await.ok()
}

async fn perform<R: Runtime>(
    app: &AppHandle<R>,
    request: ActionRequest,
    paths: Vec<PathBuf>,
) -> Done {
    match request {
        ActionRequest::Capture { target, delay } => capture_screen(app, target, delay).await,
        ActionRequest::Text => capture_text().await,
        ActionRequest::Color { format } => pick_color(app, format).await,
        ActionRequest::Zip => {
            let output = blocking(move || files::zip_files(&paths)).await;
            one_file(
                i18n::t("actions.zip.done"),
                i18n::t("actions.zip.failed"),
                output,
            )
        }
        ActionRequest::Extract => extract(paths).await,
        ActionRequest::PdfText => pdf_text(paths).await,
        ActionRequest::ReadText => read_images_text(paths).await,
        ActionRequest::CopyImage => copy_image_file(paths).await,
        ActionRequest::CopyPaths => copy_paths(&paths),
        ActionRequest::ImagesToPdf => {
            let output = blocking(move || files::images_to_pdf(&paths)).await;
            one_file(
                i18n::t("actions.imagesToPdf.done"),
                i18n::t("actions.imagesToPdf.failed"),
                output,
            )
        }
        ActionRequest::MergePdfs => {
            let output = blocking(move || files::merge_pdfs(&paths)).await;
            one_file(
                i18n::t("actions.mergePdfs.done"),
                i18n::t("actions.mergePdfs.failed"),
                output,
            )
        }
        ActionRequest::Rename { style } => rename(paths, style).await,
        ActionRequest::Retouch { retouch } => retouch_images(app, paths, retouch).await,
        ActionRequest::Video { rework } => rework_videos(app, paths, rework).await,
        ActionRequest::Place { layout } => place_window(app, layout).await,
        ActionRequest::Custom { wheel, action } => run_custom(app, wheel, action, paths).await,
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

fn one_file(
    title: String,
    failed: String,
    output: Option<Result<PathBuf, converter::ConvertError>>,
) -> Done {
    match output {
        Some(Ok(path)) => Ok(Some(Message {
            title,
            body: file_name(&path),
            action: Some(Action::Reveal(vec![path])),
        })),
        Some(Err(err)) => Err(failure(failed, err.to_string())),
        None => Err(failure(failed, interrupted())),
    }
}

/// Bilan d'une action appliquée fichier par fichier.
fn summary(
    title: impl FnOnce(u64) -> String,
    failed_title: String,
    done: Vec<PathBuf>,
    failed: Vec<String>,
) -> Done {
    if done.is_empty() {
        let reason = failed
            .into_iter()
            .next()
            .unwrap_or_else(|| i18n::t("errors.noFiles"));
        return Err(failure(failed_title, reason));
    }
    let title = title(done.len() as u64);
    let mut body = if done.len() == 1 {
        file_name(&done[0])
    } else {
        i18n::tn(
            "files.andMore",
            done.len() as u64 - 1,
            &[("names", &file_name(&done[0]))],
        )
    };
    if let Some(reason) = failed.first() {
        let line = i18n::tn(
            "actions.failures",
            failed.len() as u64,
            &[("reason", reason)],
        );
        body = format!("{body}\n{line}");
    }
    Ok(Some(Message {
        title,
        body,
        action: Some(Action::Reveal(done)),
    }))
}

async fn rename(paths: Vec<PathBuf>, style: RenameStyle) -> Done {
    match blocking(move || files::rename_files(&paths, style)).await {
        Some(Ok(done)) => summary(
            |count| i18n::tn("actions.rename.done", count, &[]),
            i18n::t("actions.rename.failed"),
            done,
            Vec::new(),
        ),
        Some(Err(err)) => Err(failure(i18n::t("actions.rename.failed"), err.to_string())),
        None => Err(failure(i18n::t("actions.rename.failed"), interrupted())),
    }
}

async fn extract(paths: Vec<PathBuf>) -> Done {
    let results = blocking(move || {
        let mut done = Vec::new();
        let mut failed = Vec::new();
        for path in &paths {
            match files::extract_zip(path) {
                Ok(output) => done.push(output),
                Err(err) => failed.push(i18n::tf(
                    "files.failureLine",
                    &[("name", &file_name(path)), ("reason", &err)],
                )),
            }
        }
        (done, failed)
    })
    .await
    .unwrap_or_default();
    summary(
        |count| i18n::tn("actions.extract.done", count, &[]),
        i18n::t("actions.extract.failed"),
        results.0,
        results.1,
    )
}

async fn pdf_text(paths: Vec<PathBuf>) -> Done {
    let title = i18n::t("actions.read.failed");
    match blocking(move || files::pdf_text(&paths)).await {
        Some(Ok(text)) => copy_found(title, &text, i18n::t("actions.read.noTextPdf")),
        Some(Err(err)) => Err(failure(title, err.to_string())),
        None => Err(failure(title, interrupted())),
    }
}

/// Fichier temporaire où écrire une image en PNG pour le système.
fn temporary_png(purpose: &str) -> PathBuf {
    std::env::temp_dir().join(format!("rutile-{purpose}-{}.png", std::process::id()))
}

/// L'image en PNG dans un fichier temporaire, passée à `use_png`, puis effacée.
fn with_png<T>(
    path: &Path,
    purpose: &str,
    use_png: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let png = converter::to_png(path).map_err(|err| {
        i18n::tf(
            "files.failureLine",
            &[("name", &file_name(path)), ("reason", &err)],
        )
    })?;
    let temporary = temporary_png(purpose);
    std::fs::write(&temporary, png).map_err(|err| err.to_string())?;
    let result = use_png(&temporary);
    let _ = std::fs::remove_file(&temporary);
    result
}

async fn read_images_text(paths: Vec<PathBuf>) -> Done {
    let title = i18n::t("actions.read.failed");
    let texts = blocking(move || {
        paths
            .iter()
            .map(|path| with_png(path, "texte", capture::read_text))
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .unwrap_or_else(|| Err(interrupted()))
    .map_err(|err| failure(title.as_str(), err))?;
    let text = texts
        .iter()
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    copy_found(title, &text, i18n::t("actions.read.noTextImage"))
}

async fn copy_image_file(paths: Vec<PathBuf>) -> Done {
    let title = i18n::t("actions.copy.failed");
    let Some(path) = paths.into_iter().next() else {
        return Err(failure(title, i18n::t("actions.copy.noImage")));
    };
    let name = file_name(&path);
    blocking(move || with_png(&path, "copie", capture::copy_image))
        .await
        .unwrap_or_else(|| Err(interrupted()))
        .map_err(|err| failure(title, err))?;
    Ok(Some(Message {
        title: i18n::t("actions.copy.imageDone"),
        body: name,
        action: None,
    }))
}

fn copy_paths(paths: &[PathBuf]) -> Done {
    let title = i18n::t("actions.copy.failed");
    if paths.is_empty() {
        return Err(failure(title, i18n::t("errors.noFiles")));
    }
    let text = paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join("\n");
    capture::copy_text(&text).map_err(|err| failure(title, err))?;
    Ok(Some(Message {
        title: i18n::tn("actions.copy.pathsDone", paths.len() as u64, &[]),
        body: preview(&text),
        action: None,
    }))
}

async fn retouch_images<R: Runtime>(
    app: &AppHandle<R>,
    paths: Vec<PathBuf>,
    action: Retouch,
) -> Done {
    let quality = settings::current(app).quality();
    let (title, failed_title): (fn(u64) -> String, String) = match action {
        Retouch::Half | Retouch::FullHd => (
            |count| i18n::tn("actions.shrink.done", count, &[]),
            i18n::t("actions.shrink.failed"),
        ),
        Retouch::Compress => (
            |count| i18n::tn("actions.compress.done", count, &[]),
            i18n::t("actions.compress.failed"),
        ),
        Retouch::StripMetadata => (
            |count| i18n::tn("actions.strip.done", count, &[]),
            i18n::t("actions.strip.failed"),
        ),
    };
    let results = blocking(move || {
        let mut done = Vec::new();
        let mut failed = Vec::new();
        for path in &paths {
            match retouch::retouch(path, action, &quality) {
                Ok(output) => done.push(output),
                Err(err) => failed.push(i18n::tf(
                    "files.failureLine",
                    &[("name", &file_name(path)), ("reason", &err)],
                )),
            }
        }
        (done, failed)
    })
    .await
    .unwrap_or_default();
    summary(title, failed_title, results.0, results.1)
}

async fn rework_videos<R: Runtime>(
    app: &AppHandle<R>,
    paths: Vec<PathBuf>,
    rework: VideoRework,
) -> Done {
    let handle = app.clone();
    let results = blocking(move || {
        let total = paths.len().max(1) as f64;
        let mut done = Vec::new();
        let mut failed = Vec::new();
        for (index, path) in paths.iter().enumerate() {
            let progress = |fraction: f64| {
                let overall = (index as f64 + fraction) / total;
                let _ = handle.emit_to(WHEEL_LABEL, PROGRESS_EVENT, overall);
            };
            match video::rework_video(path, rework, progress) {
                Ok(output) => done.push(output),
                Err(err) => failed.push(i18n::tf(
                    "files.failureLine",
                    &[("name", &file_name(path)), ("reason", &err)],
                )),
            }
        }
        (done, failed)
    })
    .await
    .unwrap_or_default();
    let title: fn(u64) -> String = match rework {
        VideoRework::Mute => |count| i18n::tn("actions.mute.done", count, &[]),
        _ => |count| i18n::tn("actions.videoCompress.done", count, &[]),
    };
    summary(title, i18n::t("actions.video.failed"), results.0, results.1)
}

/// `Capture 2026-11-06 à 10.12.33.png`, dans un dossier « Rutile » des images.
fn capture_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .picture_dir()
        .map_err(|err| err.to_string())?
        .join("Rutile");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let now = chrono::Local::now();
    let name = i18n::tf(
        "capture.fileName",
        &[
            ("date", &now.format("%Y-%m-%d")),
            ("time", &now.format("%H.%M.%S")),
        ],
    );
    Ok(dir.join(format!("{name}.png")))
}

fn capture_failure(err: CaptureError) -> Message {
    match err {
        CaptureError::Failed(reason) => failure(i18n::t("capture.failed"), reason),
        CaptureError::Permission => permission_message(),
    }
}

#[cfg(target_os = "macos")]
fn permission_message() -> Message {
    Message {
        title: i18n::t("permissions.title"),
        body: i18n::t("capture.permissionBody"),
        action: Some(Action::OpenUrl(capture::SCREEN_SETTINGS_URL.into())),
    }
}

#[cfg(not(target_os = "macos"))]
fn permission_message() -> Message {
    failure(
        i18n::t("capture.failed"),
        i18n::t("capture.permissionDenied"),
    )
}

async fn capture_screen<R: Runtime>(app: &AppHandle<R>, target: CaptureTarget, delay: u32) -> Done {
    let output = capture_path(app).map_err(|err| failure(i18n::t("capture.failed"), err))?;
    let path = output.clone();
    let taken = blocking(move || capture::capture(target, delay, &path))
        .await
        .unwrap_or_else(|| Err(CaptureError::Failed(i18n::t("capture.interrupted"))));
    if !taken.map_err(capture_failure)? {
        return Ok(None);
    }
    let image = output.clone();
    let copied = blocking(move || capture::copy_image(&image)).await;
    if settings::current(app).capture_reopen {
        let handle = app.clone();
        let image = output.clone();
        thread::spawn(move || {
            thread::sleep(REOPEN_DELAY);
            wheel::open(&handle, Source::Files(vec![image]));
        });
    }
    let body = match copied {
        Some(Ok(())) => i18n::tf("capture.alsoCopied", &[("name", &file_name(&output))]),
        _ => file_name(&output),
    };
    Ok(Some(Message {
        title: i18n::t("capture.saved"),
        body,
        action: Some(Action::Reveal(vec![output])),
    }))
}

/// Les premiers mots d'un texte, sur une ligne.
fn preview(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= TEXT_PREVIEW {
        return line;
    }
    let short: String = line.chars().take(TEXT_PREVIEW).collect();
    format!("{}…", short.trim_end())
}

async fn capture_text() -> Done {
    let title = i18n::t("actions.read.failed");
    let path = temporary_png("texte");
    let image = path.clone();
    let result = blocking(move || {
        let taken = capture::capture(CaptureTarget::Zone, 0, &image).map_err(capture_failure)?;
        if !taken {
            return Ok(None);
        }
        capture::read_text(&image)
            .map(Some)
            .map_err(|err| failure(i18n::t("actions.read.failed"), err))
    })
    .await
    .unwrap_or_else(|| Err(failure(i18n::t("actions.read.failed"), interrupted())));
    let _ = std::fs::remove_file(&path);

    let Some(text) = result? else {
        return Ok(None);
    };
    copy_found(title, &text, i18n::t("actions.read.noTextZone"))
}

/// Copie le texte trouvé, annoncé par ses premiers mots ; `nothing` s'il n'y en a pas.
fn copy_found(title: String, text: &str, nothing: String) -> Done {
    if text.trim().is_empty() {
        return Err(failure(title, nothing));
    }
    capture::copy_text(text).map_err(|err| failure(title, err))?;
    Ok(Some(Message {
        title: i18n::t("actions.read.copied"),
        body: preview(text),
        action: None,
    }))
}

/// Écriture d'une couleur, telle qu'on la colle dans une feuille de style.
fn color_text([red, green, blue]: [u8; 3], format: ColorFormat) -> String {
    match format {
        ColorFormat::Hex => format!("#{red:02x}{green:02x}{blue:02x}"),
        ColorFormat::Rgb => format!("rgb({red}, {green}, {blue})"),
        ColorFormat::Hsl => {
            let (hue, saturation, lightness) = hsl(red, green, blue);
            format!("hsl({hue}, {saturation}%, {lightness}%)")
        }
    }
}

fn hsl(red: u8, green: u8, blue: u8) -> (u32, u32, u32) {
    let [r, g, b] = [red, green, blue].map(|channel| f64::from(channel) / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let lightness = (max + min) / 2.0;
    let delta = max - min;
    if delta == 0.0 {
        return (0, 0, (lightness * 100.0).round() as u32);
    }
    let saturation = delta / (1.0 - (2.0 * lightness - 1.0).abs());
    let sector = if max == r {
        ((g - b) / delta).rem_euclid(6.0)
    } else if max == g {
        (b - r) / delta + 2.0
    } else {
        (r - g) / delta + 4.0
    };
    (
        (sector * 60.0).round() as u32 % 360,
        (saturation * 100.0).round() as u32,
        (lightness * 100.0).round() as u32,
    )
}

async fn pick_color<R: Runtime>(app: &AppHandle<R>, format: ColorFormat) -> Done {
    let title = i18n::t("actions.color.failed");
    let (sender, receiver) = mpsc::channel();
    app.run_on_main_thread(move || {
        capture::pick_color(move |color| {
            let _ = sender.send(color);
        });
    })
    .map_err(|err| failure(title.as_str(), err.to_string()))?;
    let picked = blocking(move || receiver.recv().ok().flatten())
        .await
        .flatten();
    let Some(color) = picked else {
        return Ok(None);
    };
    let text = color_text(color, format);
    capture::copy_text(&text).map_err(|err| failure(title, err))?;
    Ok(Some(Message {
        title: i18n::t("actions.color.copied"),
        body: text,
        action: None,
    }))
}

async fn place_window<R: Runtime>(app: &AppHandle<R>, layout: Layout) -> Done {
    let title = i18n::t("actions.place.failed");
    let (sender, receiver) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(placement::place(layout));
    })
    .map_err(|err| failure(title.as_str(), err.to_string()))?;
    let placed = blocking(move || receiver.recv()).await.and_then(Result::ok);
    match placed {
        Some(Ok(())) => Ok(None),
        Some(Err(PlacementError::NoWindow)) => {
            Err(failure(title, i18n::t("actions.place.noWindow")))
        }
        Some(Err(PlacementError::Failed(reason))) => Err(failure(title, reason)),
        Some(Err(PlacementError::Permission)) => Err(accessibility_message()),
        None => Err(failure(title.as_str(), interrupted())),
    }
}

#[cfg(target_os = "macos")]
fn accessibility_message() -> Message {
    Message {
        title: i18n::t("permissions.title"),
        body: i18n::t("actions.place.permissionBody"),
        action: Some(Action::OpenUrl(
            platform::apps::ACCESSIBILITY_SETTINGS_URL.into(),
        )),
    }
}

#[cfg(not(target_os = "macos"))]
fn accessibility_message() -> Message {
    failure(
        i18n::t("actions.place.failed"),
        i18n::t("actions.place.permissionDenied"),
    )
}

/// Sous Windows, une console s'ouvrirait le temps de la commande sans ce réglage.
fn hidden(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Commande à lancer pour un raccourci ou une commande ; les fichiers en sont les arguments.
fn custom_command(action: &CustomPart, paths: &[PathBuf]) -> Option<Command> {
    match action.kind {
        PartKind::Shortcut => {
            let mut command = hidden("/usr/bin/shortcuts");
            command.args(["run", action.value.as_str()]);
            for path in paths {
                command.arg("--input-path").arg(path);
            }
            Some(command)
        }
        PartKind::Command if cfg!(windows) => {
            let mut command = hidden("cmd");
            command.args(["/C", action.value.as_str()]).args(paths);
            Some(command)
        }
        PartKind::Command => {
            // `$1`, `$2`… : les fichiers, sans qu'un nom bizarre devienne du code
            let mut command = hidden("/bin/sh");
            command
                .args(["-c", action.value.as_str(), "rutile"])
                .args(paths);
            Some(command)
        }
        _ => None,
    }
}

async fn run_custom<R: Runtime>(
    app: &AppHandle<R>,
    wheel: usize,
    action: usize,
    paths: Vec<PathBuf>,
) -> Done {
    let title = i18n::t("actions.custom.failed");
    let chosen = settings::current(app)
        .custom_wheels
        .get(wheel)
        .and_then(|wheel| wheel.parts().get(action))
        .cloned()
        .ok_or_else(|| failure(title.as_str(), i18n::t("actions.custom.gone")))?;
    match chosen.kind {
        PartKind::Url => {
            if !settings::web_address(&chosen.value) {
                return Err(failure(title, i18n::t("apps.onlyWebAddresses")));
            }
            app.opener()
                .open_url(chosen.value.trim(), None::<&str>)
                .map_err(|err| failure(title.as_str(), err.to_string()))?;
            return Ok(None);
        }
        PartKind::Folder => {
            app.opener()
                .open_path(chosen.value.as_str(), None::<&str>)
                .map_err(|err| failure(title.as_str(), err.to_string()))?;
            return Ok(None);
        }
        // Comme sur la roue des apps : les fichiers de la roue s'ouvrent avec elle
        PartKind::App => {
            let name = chosen.name.clone();
            return match blocking(move || platform::apps::launch(Path::new(&chosen.value), &paths))
                .await
            {
                Some(Ok(())) => Ok(None),
                Some(Err(err)) => Err(failure(
                    title,
                    i18n::tf("files.failureLine", &[("name", &name), ("reason", &err)]),
                )),
                None => Err(failure(title.as_str(), interrupted())),
            };
        }
        // L'interface les lance elle-même, comme sur les roues de Rutile
        PartKind::Convert | PartKind::Action => {
            return Err(failure(title, i18n::t("actions.custom.fromWheel")));
        }
        PartKind::Shortcut | PartKind::Command => {}
    }
    let name = chosen.name.clone();
    let output = blocking(move || {
        let mut command = custom_command(&chosen, &paths)?;
        Some(command.stdin(Stdio::null()).output())
    })
    .await
    .flatten();
    match output {
        Some(Ok(output)) if output.status.success() => Ok(Some(Message {
            title: name,
            body: i18n::t("actions.custom.done"),
            action: None,
        })),
        Some(Ok(output)) => {
            let errors = String::from_utf8_lossy(&output.stderr);
            let reason = errors
                .lines()
                .last()
                .map_or_else(|| i18n::t("actions.custom.commandFailed"), str::to_owned);
            Err(failure(
                title,
                i18n::tf("files.failureLine", &[("name", &name), ("reason", &reason)]),
            ))
        }
        Some(Err(err)) => Err(failure(
            title,
            i18n::tf("files.failureLine", &[("name", &name), ("reason", &err)]),
        )),
        None => Err(failure(title.as_str(), interrupted())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Photo JPEG avec du texte, dessinée par AppKit.
    #[cfg(target_os = "macos")]
    fn photo_with_text(path: &Path) -> bool {
        let script = path.with_extension("swift");
        let source = r#"
import AppKit
let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: 900, pixelsHigh: 200, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: 900, height: 200).fill()
("Facture payée" as NSString).draw(
    at: NSPoint(x: 40, y: 60),
    withAttributes: [.font: NSFont.systemFont(ofSize: 64), .foregroundColor: NSColor.black])
try rep.representation(using: .jpeg, properties: [:])!
    .write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
"#;
        let drawn = std::fs::write(&script, source).is_ok()
            && Command::new("/usr/bin/swift")
                .arg(&script)
                .arg(path)
                .status()
                .is_ok_and(|status| status.success());
        let _ = std::fs::remove_file(&script);
        drawn && path.is_file()
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn le_texte_d_une_photo_se_lit_comme_celui_d_une_capture() {
        let path = std::env::temp_dir().join(format!("rutile-photo-{}.jpg", std::process::id()));
        if !photo_with_text(&path) {
            eprintln!("image de test impossible à créer : test ignoré");
            return;
        }
        let text = with_png(&path, "essai", capture::read_text).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(text.contains("Facture"), "texte lu : {text:?}");
        assert!(
            !temporary_png("essai").exists(),
            "le PNG temporaire est effacé"
        );
    }

    #[test]
    fn un_fichier_qui_n_est_pas_une_image_est_nomme_dans_l_erreur() {
        let path = std::env::temp_dir().join(format!("rutile-note-{}.txt", std::process::id()));
        std::fs::write(&path, "pas une image").unwrap();
        let err = with_png(&path, "essai", |_| Ok(())).unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert!(err.starts_with("rutile-note-"), "{err}");
    }

    #[test]
    fn une_couleur_s_ecrit_dans_les_trois_formats() {
        let orange = [0xf9, 0x73, 0x16];
        assert_eq!(color_text(orange, ColorFormat::Hex), "#f97316");
        assert_eq!(color_text(orange, ColorFormat::Rgb), "rgb(249, 115, 22)");
        assert_eq!(color_text(orange, ColorFormat::Hsl), "hsl(25, 95%, 53%)");
    }

    #[test]
    fn un_gris_n_a_ni_teinte_ni_saturation() {
        assert_eq!(
            color_text([128, 128, 128], ColorFormat::Hsl),
            "hsl(0, 0%, 50%)"
        );
    }

    #[test]
    fn un_long_texte_est_coupe_sur_une_ligne() {
        assert_eq!(preview("Bonjour\n  le   monde"), "Bonjour le monde");
        let long = "mot ".repeat(40);
        let short = preview(&long);
        assert!(short.ends_with('…'));
        assert!(short.chars().count() <= TEXT_PREVIEW + 1);
    }

    #[test]
    fn une_requete_de_la_roue_se_lit() {
        let read = |text: &str| serde_json::from_str::<ActionRequest>(text).unwrap();
        assert!(matches!(
            read(r#"{"kind":"capture","target":"zone","delay":3}"#),
            ActionRequest::Capture {
                target: CaptureTarget::Zone,
                delay: 3
            }
        ));
        assert!(matches!(
            read(r#"{"kind":"imagesToPdf"}"#),
            ActionRequest::ImagesToPdf
        ));
        assert!(matches!(
            read(r#"{"kind":"retouch","retouch":"stripMetadata"}"#),
            ActionRequest::Retouch {
                retouch: Retouch::StripMetadata
            }
        ));
        assert!(matches!(
            read(r#"{"kind":"video","rework":{"kind":"fit","megabytes":10}}"#),
            ActionRequest::Video {
                rework: VideoRework::Fit { megabytes: 10 }
            }
        ));
        assert!(matches!(
            read(r#"{"kind":"extract"}"#),
            ActionRequest::Extract
        ));
        assert!(matches!(
            read(r#"{"kind":"pdfText"}"#),
            ActionRequest::PdfText
        ));
        assert!(matches!(
            read(r#"{"kind":"readText"}"#),
            ActionRequest::ReadText
        ));
        assert!(matches!(
            read(r#"{"kind":"copyImage"}"#),
            ActionRequest::CopyImage
        ));
        assert!(matches!(
            read(r#"{"kind":"copyPaths"}"#),
            ActionRequest::CopyPaths
        ));
        assert!(matches!(
            read(r#"{"kind":"place","layout":"maximize"}"#),
            ActionRequest::Place {
                layout: Layout::Maximize
            }
        ));
    }
}
