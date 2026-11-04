//! Fonctions propres à chaque système. Sans Tauri ni code C, cette crate se vérifie pour
//! Windows et Linux depuis n'importe quelle machine (`cargo check --target …`).

pub mod apps;
pub mod mouse;
pub mod selection;
pub mod session;
