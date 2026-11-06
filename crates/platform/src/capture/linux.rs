use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use ashpd::desktop::Color;
use ashpd::desktop::screenshot::Screenshot;

use super::{CaptureError, CaptureTarget};

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| err.to_string())
}

/// Le portail du bureau marche sous GNOME et KDE, sous X11 comme sous Wayland : il affiche
/// sa propre interface pour choisir la zone ou la fenêtre.
pub fn capture(target: CaptureTarget, delay: u32, output: &Path) -> Result<bool, CaptureError> {
    thread::sleep(Duration::from_secs(delay.into()));
    let interactive = target != CaptureTarget::Screen;
    let taken = runtime().map_err(CaptureError::Failed)?.block_on(async {
        Screenshot::request()
            .interactive(interactive)
            .send()
            .await?
            .response()
    });
    let screenshot = match taken {
        Ok(screenshot) => screenshot,
        Err(ashpd::Error::Response(_)) => return Ok(false),
        Err(err) => {
            return Err(CaptureError::Failed(format!(
                "portail du bureau indisponible ({err})"
            )));
        }
    };
    let source = screenshot
        .uri()
        .to_file_path()
        .map_err(|()| CaptureError::Failed("capture introuvable".into()))?;
    let result = std::fs::copy(&source, output);
    let _ = std::fs::remove_file(&source);
    result
        .map(|_| true)
        .map_err(|err| CaptureError::Failed(err.to_string()))
}

/// Linux n'a pas de moteur intégré : Tesseract, s'il est installé.
pub fn read_text(image: &Path) -> Result<String, String> {
    let output = Command::new("tesseract")
        .arg(image)
        .args(["stdout", "-l", "fra+eng"])
        .stdin(Stdio::null())
        .output()
        .map_err(|_| {
            "Installez Tesseract (paquet tesseract-ocr) pour lire le texte.".to_string()
        })?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    Err(format!(
        "Échec de Tesseract ({}). Le paquet de la langue française est-il installé ?",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

pub fn pick_color(done: impl FnOnce(Option<[u8; 3]>) + Send + 'static) {
    thread::spawn(move || {
        let picked = runtime().ok().and_then(|runtime| {
            runtime
                .block_on(async { Color::pick().send().await?.response() })
                .ok()
        });
        done(picked.map(|color| {
            let channel = |value: f64| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
            [
                channel(color.red()),
                channel(color.green()),
                channel(color.blue()),
            ]
        }));
    });
}
