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

/// Image copiée (une capture, une image d'un site), en pixels RGBA. `None` s'il n'y en a pas,
/// ou si ce sont des fichiers copiés dans le Finder : leur icône n'est pas une image à convertir.
pub fn clipboard_image() -> Option<image::RgbaImage> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    if clipboard
        .get()
        .file_list()
        .is_ok_and(|files| !files.is_empty())
    {
        return None;
    }
    let data = clipboard.get_image().ok()?;
    image::RgbaImage::from_raw(
        u32::try_from(data.width).ok()?,
        u32::try_from(data.height).ok()?,
        data.bytes.into_owned(),
    )
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
