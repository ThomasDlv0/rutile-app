//! Fonctions propres à chaque système. Sans Tauri ni code C, cette crate se vérifie pour
//! Windows et Linux depuis n'importe quelle machine (`cargo check --target …`).

pub mod apps;
pub mod capture;
#[cfg(target_os = "macos")]
pub mod glass;
#[cfg(target_os = "macos")]
mod macos_image;
pub mod mouse;
pub mod placement;
pub mod selection;
pub mod session;
pub mod share;
#[cfg(windows)]
pub mod tray;
