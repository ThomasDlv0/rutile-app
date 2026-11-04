//! Fichiers sélectionnés dans le gestionnaire de fichiers au moment du raccourci.
//!
//! En deux temps : [`capture_source`] repère tout de suite si le Finder ou l'Explorateur est
//! au premier plan, puis [`selected_files`], plus lent, lit sa sélection sur un thread de fond.
//! Linux n'a pas d'interface commune aux gestionnaires de fichiers : on y passe un fichier
//! avec `rutile --open fichier` (script Nautilus, « Ouvrir avec »).

use std::path::PathBuf;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "macos")]
pub use macos::{AUTOMATION_SETTINGS_URL, AutomationPermission, finder_automation_permission};

/// Gestionnaire de fichiers repéré au premier plan.
#[derive(Debug, Clone, Copy)]
pub struct Source(Inner);

#[derive(Debug, Clone, Copy)]
enum Inner {
    #[cfg(target_os = "macos")]
    Finder,
    /// Fenêtre de l'Explorateur ou bureau, par sa poignée.
    #[cfg(windows)]
    Explorer(isize),
}

#[derive(Debug)]
pub enum SelectionError {
    /// macOS : Rutile n'a pas l'autorisation de piloter le Finder (Automatisation).
    PermissionDenied,
    Failed(String),
}

/// À appeler avant d'afficher la roue, tant que le gestionnaire de fichiers est au premier plan.
pub fn capture_source() -> Option<Source> {
    #[cfg(target_os = "macos")]
    return macos::finder_is_frontmost().then_some(Source(Inner::Finder));
    #[cfg(windows)]
    return windows::foreground_explorer().map(|hwnd| Source(Inner::Explorer(hwnd)));
    #[cfg(not(any(target_os = "macos", windows)))]
    None
}

/// Fichiers sélectionnés (les dossiers sont ignorés). Bloquant : à appeler hors du thread principal.
// Sous Linux, aucune source n'existe : la fonction ne peut pas être appelée
#[cfg_attr(not(any(target_os = "macos", windows)), allow(unreachable_code))]
pub fn selected_files(source: Source) -> Result<Vec<PathBuf>, SelectionError> {
    let paths: Vec<PathBuf> = match source.0 {
        #[cfg(target_os = "macos")]
        Inner::Finder => macos::finder_selection()?,
        #[cfg(windows)]
        Inner::Explorer(hwnd) => windows::explorer_selection(hwnd)?,
    };
    Ok(paths.into_iter().filter(|path| path.is_file()).collect())
}
