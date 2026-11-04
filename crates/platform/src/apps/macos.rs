use std::path::{Path, PathBuf};
use std::process::Command;

use objc2::AnyThread;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
use objc2_foundation::{NSDictionary, NSFileManager, NSPoint, NSRect, NSSize, NSString};

use super::{App, Icon, name_from_file};

/// Côté de l'icône en points ; un écran Retina la rend au double.
const ICON_SIZE: f64 = 128.0;

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
    let mut rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(ICON_SIZE, ICON_SIZE));
    // SAFETY : rectangle valide pendant l'appel, sans contexte ni indications
    let cg_image = unsafe { image.CGImageForProposedRect_context_hints(&mut rect, None, None) }?;
    let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg_image);
    // SAFETY : dictionnaire de propriétés vide, accepté par AppKit
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(png.to_vec())
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
}
