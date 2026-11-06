//! Capture d'écran, lecture du texte d'une image et pipette, propres à chaque système.

use std::path::Path;

use serde::Deserialize;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux as system;
#[cfg(target_os = "macos")]
use macos as system;
#[cfg(windows)]
use windows as system;

/// Ce que l'on capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureTarget {
    /// Une zone tracée à la souris.
    Zone,
    /// Une fenêtre désignée à la souris (la fenêtre active sous Windows).
    Window,
    Screen,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CaptureError {
    /// macOS : Rutile n'a pas l'autorisation « Enregistrement de l'écran ».
    Permission,
    Failed(String),
}

/// Écrit la capture dans `output` en PNG, après `delay` secondes. Faux si l'utilisateur
/// annule. Bloquant, le temps que l'utilisateur choisisse.
pub fn capture(target: CaptureTarget, delay: u32, output: &Path) -> Result<bool, CaptureError> {
    system::capture(target, delay, output)
}

/// Texte d'une image, ligne par ligne. Hors ligne, avec le moteur du système (Tesseract sous
/// Linux, s'il est installé). Bloquant.
pub fn read_text(image: &Path) -> Result<String, String> {
    system::read_text(image)
}

/// Couleur prise à l'écran, en sRGB. `done` reçoit `None` si l'utilisateur annule. À appeler
/// depuis le thread principal.
pub fn pick_color(done: impl FnOnce(Option<[u8; 3]>) + Send + 'static) {
    system::pick_color(done);
}

/// Réglages Système où se donne l'autorisation « Enregistrement de l'écran ».
#[cfg(target_os = "macos")]
pub use macos::SCREEN_SETTINGS_URL;

/// Met du texte dans le presse-papiers.
pub fn copy_text(text: &str) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|err| err.to_string())
}

/// Met une image PNG dans le presse-papiers.
pub fn copy_image(path: &Path) -> Result<(), String> {
    let image = image::open(path).map_err(|err| err.to_string())?.to_rgba8();
    let (width, height) = image.dimensions();
    let data = arboard::ImageData {
        width: width as usize,
        height: height as usize,
        bytes: image.into_raw().into(),
    };
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_image(data))
        .map_err(|err| err.to_string())
}
