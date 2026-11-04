//! Roue de partage : services du système (AirDrop, Messages…), dossiers synchronisés avec un
//! service en ligne (Google Drive, iCloud Drive…) et presse-papiers, pour les messageries qui
//! ne proposent pas d'extension de partage.

use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

/// Identifiants des services de macOS proposés par défaut.
pub const AIRDROP: &str = "com.apple.share.AirDrop.send";
pub const MESSAGES: &str = "com.apple.share.Messages.window";
pub const MAIL: &str = "com.apple.share.Mail.compose";

/// Service de partage du système, comme AirDrop ou Messages.
#[derive(Debug, Clone)]
pub struct Service {
    /// Identifiant stable, enregistré dans les réglages (`com.apple.share.AirDrop.send`).
    pub id: String,
    pub name: String,
    /// Icône en PNG.
    pub icon: Option<Vec<u8>>,
}

/// Services de partage qui acceptent des fichiers. Seul macOS en fournit.
pub fn services() -> Vec<Service> {
    #[cfg(target_os = "macos")]
    return macos::services();
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

/// Ouvre la fenêtre du service `id` (choix de l'appareil AirDrop, du destinataire…) pour
/// `files`. Sur macOS, à appeler depuis le thread principal.
pub fn share(id: &str, files: &[PathBuf]) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::share(id, files);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (id, files);
        Err("Les services de partage n'existent que sur macOS.".into())
    }
}

/// Dossier synchronisé avec un service en ligne : y copier un fichier l'envoie en ligne.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudFolder {
    pub name: String,
    pub path: PathBuf,
    /// Fichier dont l'icône représente le service (l'app Google Drive, par exemple).
    pub icon: Option<PathBuf>,
}

/// Dossiers synchronisés présents sur la machine : Google Drive, iCloud Drive, Dropbox…
pub fn cloud_folders() -> Vec<CloudFolder> {
    #[cfg(target_os = "macos")]
    return macos::cloud_folders();
    #[cfg(windows)]
    return windows::cloud_folders();
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let Some(home) = home() else {
            return Vec::new();
        };
        [
            ("Dropbox", "Dropbox"),
            ("Google Drive", "Google Drive"),
            ("Google Drive", "GoogleDrive"),
            ("OneDrive", "OneDrive"),
            ("Nextcloud", "Nextcloud"),
            ("pCloud", "pCloudDrive"),
        ]
        .into_iter()
        .map(|(name, dir)| CloudFolder {
            name: name.into(),
            path: home.join(dir),
            icon: None,
        })
        .filter(|folder| folder.path.is_dir())
        .collect()
    }
}

/// Messageries installées qui n'ont pas d'extension de partage, comme Signal : la roue met
/// le fichier dans le presse-papiers et les ouvre, il reste à le coller dans la conversation.
pub fn messaging_apps() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    let candidates: Vec<PathBuf> = [
        "Signal",
        "WhatsApp",
        "Telegram",
        "Discord",
        "Slack",
        "Messenger",
    ]
    .iter()
    .map(|name| PathBuf::from(format!("/Applications/{name}.app")))
    .collect();
    #[cfg(windows)]
    let candidates: Vec<PathBuf> = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|local| {
            vec![
                local.join(r"Programs\signal-desktop\Signal.exe"),
                local.join(r"slack\slack.exe"),
            ]
        })
        .unwrap_or_default()
        .into_iter()
        .chain(
            std::env::var_os("APPDATA")
                .map(|roaming| PathBuf::from(roaming).join(r"Telegram Desktop\Telegram.exe")),
        )
        .collect();
    #[cfg(not(any(target_os = "macos", windows)))]
    let candidates: Vec<PathBuf> = {
        let mut dirs = vec![
            PathBuf::from("/usr/share/applications"),
            PathBuf::from("/var/lib/flatpak/exports/share/applications"),
        ];
        if let Some(home) = home() {
            dirs.push(home.join(".local/share/flatpak/exports/share/applications"));
        }
        let names = [
            "signal-desktop.desktop",
            "org.signal.Signal.desktop",
            "org.telegram.desktop.desktop",
            "com.discordapp.Discord.desktop",
            "com.slack.Slack.desktop",
        ];
        names
            .iter()
            .flat_map(|name| dirs.iter().map(move |dir| dir.join(name)))
            .collect()
    };
    candidates
        .into_iter()
        .filter(|path| path.exists())
        .collect()
}

/// Met les fichiers dans le presse-papiers, comme une copie depuis le Finder ou l'Explorateur.
pub fn copy_files(files: &[PathBuf]) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::copy_files(files);
    #[cfg(windows)]
    return windows::copy_files(files);
    #[cfg(target_os = "linux")]
    return linux::copy_files(files);
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        let _ = files;
        Err("système non pris en charge".into())
    }
}

#[cfg_attr(windows, allow(dead_code))]
fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Nom affiché d'un dossier : le dernier élément de son chemin.
pub fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}
