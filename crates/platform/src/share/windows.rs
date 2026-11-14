use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;

use windows::Win32::Foundation::{GlobalFree, HANDLE};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows::Win32::System::Ole::CF_HDROP;
use windows::Win32::UI::Shell::DROPFILES;

use super::CloudFolder;

/// Google Drive monte un lecteur (G: par défaut) ; OneDrive, Dropbox et iCloud ont un dossier
/// dans le profil.
pub fn cloud_folders() -> Vec<CloudFolder> {
    let mut folders = Vec::new();
    for letter in b'D'..=b'Z' {
        let drive = PathBuf::from(format!("{}:\\", letter as char));
        if let Some(path) = ["My Drive", "Mon Drive"]
            .iter()
            .map(|name| drive.join(name))
            .find(|path| path.is_dir())
        {
            folders.push(folder("Google Drive", path));
        }
    }
    if let Some(path) = std::env::var_os("OneDrive") {
        folders.push(folder("OneDrive", PathBuf::from(path)));
    }
    if let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        folders.push(folder("Dropbox", profile.join("Dropbox")));
        folders.push(folder("iCloud Drive", profile.join("iCloudDrive")));
    }
    folders.retain(|folder| folder.path.is_dir());
    folders
}

fn folder(name: &str, path: PathBuf) -> CloudFolder {
    CloudFolder {
        name: name.into(),
        path,
        icon: None,
    }
}

/// Format CF_HDROP, celui d'une copie dans l'Explorateur : un en-tête DROPFILES suivi des
/// chemins en UTF-16, chacun terminé par un zéro, et un zéro final.
pub fn copy_files(files: &[PathBuf]) -> Result<(), String> {
    let mut paths: Vec<u16> = Vec::new();
    for file in files {
        paths.extend(file.as_os_str().encode_wide());
        paths.push(0);
    }
    paths.push(0);
    let header = size_of::<DROPFILES>();
    let size = header + paths.len() * size_of::<u16>();

    // SAFETY : la mémoire allouée fait `size` octets ; elle appartient au presse-papiers une
    // fois SetClipboardData réussi, et est libérée ici sinon
    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE, size).map_err(|err| err.to_string())?;
        let pointer = GlobalLock(memory).cast::<u8>();
        if pointer.is_null() {
            let _ = GlobalFree(Some(memory));
            return Err(i18n::t("share.clipboardMemory"));
        }
        let drop_files = DROPFILES {
            pFiles: header as u32,
            fWide: true.into(),
            ..Default::default()
        };
        pointer.cast::<DROPFILES>().write_unaligned(drop_files);
        std::ptr::copy_nonoverlapping(
            paths.as_ptr().cast::<u8>(),
            pointer.add(header),
            paths.len() * size_of::<u16>(),
        );
        // Renvoie une « erreur » quand le verrou tombe à zéro, ce qui est le cas attendu
        let _ = GlobalUnlock(memory);

        if let Err(err) = OpenClipboard(None) {
            let _ = GlobalFree(Some(memory));
            return Err(err.to_string());
        }
        let result = EmptyClipboard()
            .and_then(|()| SetClipboardData(u32::from(CF_HDROP.0), Some(HANDLE(memory.0))));
        let _ = CloseClipboard();
        match result {
            Ok(_) => Ok(()),
            Err(err) => {
                let _ = GlobalFree(Some(memory));
                Err(err.to_string())
            }
        }
    }
}
