//! Icône de la barre système sous Windows.

use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_DWORD, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, RegSetKeyValueW,
};
use windows::core::{PCWSTR, PWSTR, w};

/// Windows range l'icône d'une nouvelle app dans les icônes cachées (la flèche `^`). Tant que
/// l'utilisateur n'a rien choisi, Rutile demande à la garder dans la barre : un choix fait
/// dans les paramètres de Windows reste respecté. Vrai une fois l'entrée de Rutile trouvée.
pub fn keep_visible() -> bool {
    let mut icons = HKEY::default();
    // SAFETY : la clé ouverte est refermée plus bas
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            w!("Control Panel\\NotifyIconSettings"),
            None,
            KEY_READ | KEY_SET_VALUE,
            &mut icons,
        )
    };
    if opened.is_err() {
        return false;
    }

    let mut found = false;
    for index in 0.. {
        let mut name = [0u16; 64];
        let mut length = name.len() as u32;
        // SAFETY : `length` donne la taille de `name`, que Windows termine par un zéro
        let status = unsafe {
            RegEnumKeyExW(
                icons,
                index,
                Some(PWSTR(name.as_mut_ptr())),
                &mut length,
                None,
                None,
                None,
                None,
            )
        };
        if status.is_err() {
            break;
        }
        let icon = PCWSTR(name.as_ptr());
        if is_rutile(icons, icon) {
            found = true;
            promote_unless_chosen(icons, icon);
        }
    }
    // SAFETY : clé ouverte ci-dessus, plus utilisée ensuite
    let _ = unsafe { RegCloseKey(icons) };
    found
}

/// Windows peut écrire le chemin avec un dossier connu : seul le nom du fichier est sûr.
fn is_rutile(icons: HKEY, icon: PCWSTR) -> bool {
    let mut path = [0u16; 1024];
    let mut size = size_of_val(&path) as u32;
    // SAFETY : `size` donne la taille en octets de `path`
    let read = unsafe {
        RegGetValueW(
            icons,
            icon,
            w!("ExecutablePath"),
            RRF_RT_REG_SZ,
            None,
            Some(path.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    let length = path
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(path.len());
    read.is_ok()
        && String::from_utf16_lossy(&path[..length])
            .to_lowercase()
            .ends_with("\\rutile.exe")
}

/// `IsPromoted` n'existe que si l'utilisateur a choisi, ou si Rutile l'a déjà écrit.
fn promote_unless_chosen(icons: HKEY, icon: PCWSTR) {
    // SAFETY : aucun tampon : Windows dit seulement si la valeur existe
    let chosen = unsafe {
        RegGetValueW(
            icons,
            icon,
            w!("IsPromoted"),
            RRF_RT_REG_DWORD,
            None,
            None,
            None,
        )
    };
    if chosen.is_ok() {
        return;
    }
    let promoted = 1u32;
    // SAFETY : les 4 octets annoncés sont ceux de `promoted`
    let _ = unsafe {
        RegSetKeyValueW(
            icons,
            icon,
            w!("IsPromoted"),
            REG_DWORD.0,
            Some(std::ptr::from_ref(&promoted).cast()),
            size_of_val(&promoted) as u32,
        )
    };
}
