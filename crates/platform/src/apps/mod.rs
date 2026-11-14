//! Applications de la roue des apps : nom, icône et lancement, propres à chaque système.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

/// Icône d'une app : image déjà encodée (PNG), ou fichier PNG ou SVG à lire.
#[derive(Debug)]
pub enum Icon {
    Encoded(Vec<u8>),
    File(PathBuf),
}

#[derive(Debug)]
pub struct App {
    pub name: String,
    pub icon: Option<Icon>,
}

/// Nom et icône de l'app désignée par `path` : `.app` sur macOS, `.exe` ou raccourci `.lnk`
/// sous Windows, `.desktop` ou exécutable sous Linux.
pub fn describe(path: &Path) -> Option<App> {
    #[cfg(target_os = "macos")]
    return macos::describe(path);
    #[cfg(windows)]
    return windows::describe(path);
    #[cfg(target_os = "linux")]
    return linux::describe(path);
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        let _ = path;
        None
    }
}

/// Lance l'app (ou la ramène au premier plan), en lui faisant ouvrir `files` s'il y en a.
pub fn launch(app: &Path, files: &[PathBuf]) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::launch(app, files);
    #[cfg(windows)]
    return windows::launch(app, files);
    #[cfg(target_os = "linux")]
    return linux::launch(app, files);
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        let _ = (app, files);
        Err(i18n::t("errors.unsupportedSystem"))
    }
}

#[cfg(target_os = "macos")]
pub use macos::{ACCESSIBILITY_SETTINGS_URL, dock_access, request_dock_access};

/// Pastilles de notifications, par chemin d'app, comme dans le Dock : celles des apps
/// ouvertes, et celles des apps fermées si Rutile peut lire le Dock (`dock_access`). Seul
/// macOS les rend lisibles par une autre app.
pub fn badges() -> HashMap<PathBuf, String> {
    #[cfg(target_os = "macos")]
    return macos::badges();
    #[cfg(not(target_os = "macos"))]
    HashMap::new()
}

/// Ce que propose le sélecteur d'app : extensions acceptées et dossier de départ.
pub fn picker() -> (&'static [&'static str], Option<PathBuf>) {
    #[cfg(target_os = "macos")]
    return (&["app"], Some(PathBuf::from("/Applications")));
    #[cfg(windows)]
    return (
        &["exe", "lnk"],
        std::env::var_os("ProgramData")
            .map(|data| PathBuf::from(data).join(r"Microsoft\Windows\Start Menu\Programs")),
    );
    #[cfg(not(any(target_os = "macos", windows)))]
    (&["desktop"], Some(PathBuf::from("/usr/share/applications")))
}

/// Nom affiché à partir du nom de fichier (« Brave Browser.app » → « Brave Browser »).
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn name_from_file(path: &Path) -> Option<String> {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
}
