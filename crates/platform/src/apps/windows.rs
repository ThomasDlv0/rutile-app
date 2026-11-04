use std::path::{Path, PathBuf};

use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{HSTRING, PCWSTR, w};

use super::{App, name_from_file};

/// Nom tiré du fichier ; l'icône n'est pas encore extraite sous Windows (initiales à la place).
pub fn describe(path: &Path) -> Option<App> {
    Some(App {
        name: name_from_file(path)?,
        icon: None,
    })
}

/// ShellExecute accepte aussi bien un `.exe` qu'un raccourci `.lnk` du menu Démarrer.
pub fn launch(app: &Path, files: &[PathBuf]) -> Result<(), String> {
    let parameters = files
        .iter()
        .map(|file| format!("\"{}\"", file.display()))
        .collect::<Vec<_>>()
        .join(" ");
    let app = HSTRING::from(app.as_os_str());
    let parameters = HSTRING::from(parameters);
    // SAFETY : chaînes valides pendant l'appel, sans fenêtre parente
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &app,
            if files.is_empty() {
                PCWSTR::null()
            } else {
                PCWSTR(parameters.as_ptr())
            },
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // Une valeur supérieure à 32 signifie que le lancement a réussi
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!("Windows n'a pas pu ouvrir « {} »", app))
    }
}
