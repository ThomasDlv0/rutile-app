use std::collections::HashMap;
use std::ffi::{CStr, c_char, c_int, c_void};
use std::path::{Path, PathBuf};
use std::process::Command;

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSArray, NSFileManager, NSString};

use super::{App, Icon, name_from_file};
use crate::macos_image;

pub fn describe(path: &Path) -> Option<App> {
    Some(App {
        name: display_name(path).or_else(|| name_from_file(path))?,
        icon: icon_png(path).map(Icon::Encoded),
    })
}

/// Nom affiché par le Finder, traduit (« Calculator.app » devient « Calculatrice »).
fn display_name(path: &Path) -> Option<String> {
    let name = NSFileManager::defaultManager()
        .displayNameAtPath(&NSString::from_str(path.to_str()?))
        .to_string();
    let name = name.strip_suffix(".app").unwrap_or(&name).to_string();
    (!name.is_empty()).then_some(name)
}

/// Icône telle que le Finder l'affiche, qu'elle vienne d'un `.icns` ou d'un catalogue d'assets.
fn icon_png(path: &Path) -> Option<Vec<u8>> {
    let image = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path.to_str()?));
    macos_image::png(&image)
}

/// `open -a` lance l'app ou la ramène au premier plan si elle tourne déjà.
pub fn launch(app: &Path, files: &[PathBuf]) -> Result<(), String> {
    let status = Command::new("/usr/bin/open")
        .arg("-a")
        .arg(app)
        .args(files)
        .status()
        .map_err(|err| err.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("macOS n'a pas pu ouvrir « {} »", app.display()))
    }
}

// API privée de LaunchServices, celle qu'utilise `lsappinfo` : aucune API publique ne donne
// la pastille du Dock d'une autre app. Cherchée à l'exécution, pour qu'une version de macOS
// qui la retire laisse seulement la roue sans pastilles.
type CopyRunningApplications = unsafe extern "C" fn(c_int) -> *mut NSArray<AnyObject>;
type CopyInformationItem =
    unsafe extern "C" fn(c_int, *const AnyObject, *const NSString) -> *mut AnyObject;

unsafe extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

const RTLD_LAZY: c_int = 1;
/// `kLSDefaultSessionID` : la session de l'utilisateur.
const SESSION: c_int = -2;

fn launch_services() -> Option<(CopyRunningApplications, CopyInformationItem)> {
    let framework = c"/System/Library/Frameworks/CoreServices.framework/CoreServices";
    let handle = unsafe { dlopen(framework.as_ptr(), RTLD_LAZY) };
    if handle.is_null() {
        return None;
    }
    let find = |name: &CStr| {
        let symbol = unsafe { dlsym(handle, name.as_ptr()) };
        (!symbol.is_null()).then_some(symbol)
    };
    let running = find(c"_LSCopyRunningApplicationArray")?;
    let item = find(c"_LSCopyApplicationInformationItem")?;
    // Les signatures sont celles des en-têtes de LaunchServices
    unsafe {
        Some((
            std::mem::transmute::<*mut c_void, CopyRunningApplications>(running),
            std::mem::transmute::<*mut c_void, CopyInformationItem>(item),
        ))
    }
}

/// Pastilles du Dock des apps ouvertes (« 3 », « ! »…), par chemin d'app.
pub fn badges() -> HashMap<PathBuf, String> {
    let mut badges = HashMap::new();
    let Some((running, item)) = launch_services() else {
        return badges;
    };
    // Fonctions « Copy » de Core Foundation : les objets rendus nous appartiennent
    let Some(apps) = (unsafe { Retained::from_raw(running(SESSION)) }) else {
        return badges;
    };
    let label_key = NSString::from_str("StatusLabel");
    let path_key = NSString::from_str("LSBundlePath");
    for asn in apps.iter() {
        let copy = |key: &NSString| unsafe { Retained::from_raw(item(SESSION, &*asn, key)) };
        let Some(label) = copy(&label_key).and_then(|status| status_label(&status)) else {
            continue;
        };
        if let Some(path) = copy(&path_key).and_then(|path| path.downcast::<NSString>().ok()) {
            badges.insert(PathBuf::from(path.to_string()), label);
        }
    }
    badges
}

/// Texte d'une étiquette `{ label = "3" }`, ou `None` quand l'app n'affiche rien.
fn status_label(status: &AnyObject) -> Option<String> {
    let responds: bool =
        unsafe { msg_send![status, respondsToSelector: objc2::sel!(objectForKey:)] };
    if !responds {
        return None;
    }
    let key = NSString::from_str("label");
    let value: Option<Retained<AnyObject>> = unsafe { msg_send![status, objectForKey: &*key] };
    // Une chaîne le plus souvent ; un nombre ou NSNull se lisent par leur description
    let text = match value?.downcast::<NSString>() {
        Ok(text) => text.to_string(),
        Err(other) => {
            let description: Retained<NSString> = unsafe { msg_send![&*other, description] };
            description.to_string()
        }
    };
    let text = text.trim();
    (!text.is_empty() && text != "<null>").then(|| text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrit_une_app_du_systeme_avec_son_icone() {
        let app = describe(Path::new("/System/Applications/Calculator.app")).unwrap();
        assert!(!app.name.is_empty());
        let Some(Icon::Encoded(png)) = app.icon else {
            panic!("icône absente");
        };
        assert!(png.starts_with(b"\x89PNG"), "l'icône est un PNG");
    }

    #[test]
    fn lit_les_pastilles_sans_planter() {
        // Les apps ouvertes et leurs pastilles varient : on vérifie seulement leur forme
        for (path, label) in badges() {
            assert!(path.is_absolute());
            assert!(!label.is_empty());
        }
    }
}
