use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::path::PathBuf;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObjectProtocol, ProtocolObject};
use objc2::{
    AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel,
};
use objc2_app_kit::{
    NSApplication, NSPasteboard, NSPasteboardWriting, NSSharingService, NSSharingServicePicker,
    NSSharingServicePickerDelegate, NSView,
};
use objc2_foundation::{NSArray, NSObject, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL};

use super::{CloudFolder, Service, home};
use crate::macos_image;

/// PNG transparent d'un pixel. macOS ne liste que les services qui acceptent les éléments
/// donnés, et aucun pour un fichier absent : il en faut un vrai, et une image les a tous.
const SAMPLE_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x00, 0x02, 0x00,
    0x00, 0x05, 0x00, 0x01, 0x7a, 0x5e, 0xab, 0x3f, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
];

/// Dossier des petites apps du Finder, dont les icônes représentent iCloud Drive et AirDrop.
const FINDER_APPS: &str = "/System/Library/CoreServices/Finder.app/Contents/Applications";

fn sample_file() -> Option<PathBuf> {
    let path = std::env::temp_dir().join("rutile-partage.png");
    if !path.exists() {
        std::fs::write(&path, SAMPLE_PNG).ok()?;
    }
    Some(path)
}

fn file_urls(files: &[PathBuf]) -> Result<Vec<Retained<NSURL>>, String> {
    files
        .iter()
        .map(|file| {
            NSURL::from_file_path(file)
                .ok_or_else(|| i18n::tf("share.unreadablePath", &[("path", &file.display())]))
        })
        .collect()
}

/// Les services attendent un tableau d'objets quelconques.
fn items(urls: &[Retained<NSURL>]) -> Retained<NSArray> {
    let objects: Vec<&AnyObject> = urls.iter().map(|url| url.as_ref()).collect();
    NSArray::from_slice(&objects)
}

/// L'identifiant n'est pas une propriété publique, mais c'est lui qu'accepte
/// `sharingServiceNamed:` ; le titre traduit sert à défaut.
fn service_id(service: &NSSharingService) -> String {
    if service.respondsToSelector(sel!(name)) {
        // SAFETY : la méthode existe (vérifié juste avant) et renvoie une chaîne ou nil
        let name: Option<Retained<NSString>> = unsafe { msg_send![service, name] };
        if let Some(name) = name {
            return name.to_string();
        }
    }
    service.title().to_string()
}

fn available_services(urls: &[Retained<NSURL>]) -> Retained<NSArray<NSSharingService>> {
    // Seule façon de connaître les services sans afficher le menu de partage
    #[allow(deprecated)]
    // SAFETY : tableau d'URL de fichiers, comme l'attend AppKit
    unsafe {
        NSSharingService::sharingServicesForItems(&items(urls))
    }
}

pub fn services() -> Vec<Service> {
    let Some(sample) = sample_file() else {
        return Vec::new();
    };
    let Ok(urls) = file_urls(&[sample]) else {
        return Vec::new();
    };
    available_services(&urls)
        .iter()
        .map(|service| Service {
            id: service_id(&service),
            name: service.title().to_string(),
            icon: macos_image::png(&service.image()),
        })
        .collect()
}

pub fn share(id: &str, files: &[PathBuf]) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or_else(|| i18n::t("share.mainThread"))?;
    let urls = file_urls(files)?;
    let service = NSSharingService::sharingServiceNamed(&NSString::from_str(id))
        .or_else(|| {
            available_services(&urls)
                .iter()
                .find(|service| service_id(service) == id)
        })
        .ok_or_else(|| i18n::t("share.serviceGone"))?;
    let items = items(&urls);
    // SAFETY : tableau d'URL de fichiers, comme l'attend AppKit
    if !unsafe { service.canPerformWithItems(Some(&items)) } {
        return Err(i18n::tf(
            "share.serviceRefuses",
            &[("service", &service.title())],
        ));
    }
    // Rutile passe devant : sinon la fenêtre d'AirDrop s'ouvre derrière l'app active
    #[allow(deprecated)]
    NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    // SAFETY : idem
    unsafe { service.performWithItems(&items) };
    Ok(())
}

/// Fin du menu de partage : `true` si un service a été choisi, `false` s'il a été refermé.
pub type PickerDone = Box<dyn FnOnce(bool)>;

pub struct PickerState {
    done: Cell<Option<PickerDone>>,
}

define_class!(
    // SAFETY : NSObject n'impose rien à ses sous-classes, et celle-ci n'implémente pas Drop
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "RutileSharePickerDelegate"]
    #[ivars = PickerState]
    pub struct PickerDelegate;

    unsafe impl NSObjectProtocol for PickerDelegate {}

    unsafe impl NSSharingServicePickerDelegate for PickerDelegate {
        #[unsafe(method(sharingServicePicker:didChooseSharingService:))]
        fn picker_did_choose(
            &self,
            _picker: &NSSharingServicePicker,
            service: Option<&NSSharingService>,
        ) {
            if let Some(done) = self.ivars().done.take() {
                done(service.is_some());
            }
            // Le service choisi poursuit seul : le menu et son délégué peuvent partir
            OPEN_PICKER.with(|open| open.borrow_mut().take());
        }
    }
);

impl PickerDelegate {
    fn new(mtm: MainThreadMarker, done: PickerDone) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(PickerState {
            done: Cell::new(Some(done)),
        });
        // SAFETY : `init` de NSObject, sur une instance tout juste allouée
        unsafe { msg_send![super(this), init] }
    }
}

thread_local! {
    /// Menu affiché et son délégué, gardés en vie jusqu'à la fin du choix : le menu ne retient
    /// pas son délégué.
    static OPEN_PICKER: RefCell<Option<(Retained<NSSharingServicePicker>, Retained<PickerDelegate>)>> =
        const { RefCell::new(None) };
}

/// Menu de partage de macOS, celui du bouton Partager du Finder, ouvert à droite du centre de
/// `view`. Le service choisi (Messages, AirDrop, une extension comme WhatsApp…) ouvre ensuite
/// sa fenêtre, où l'on choisit le destinataire.
pub fn show_picker(view: *mut c_void, files: &[PathBuf], done: PickerDone) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or_else(|| i18n::t("share.mainThread"))?;
    // SAFETY : pointeur de NSView fourni par la fenêtre, utilisé sur le thread principal
    let view = unsafe { view.cast::<NSView>().as_ref() }
        .ok_or_else(|| i18n::t("share.wheelWindowMissing"))?;
    let urls = file_urls(files)?;
    // SAFETY : tableau d'URL de fichiers, comme l'attend AppKit
    let picker = unsafe {
        NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items(&urls))
    };
    let delegate = PickerDelegate::new(mtm, done);
    picker.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // Un menu encore ouvert d'une fois précédente se referme d'abord
    if let Some((previous, _)) = OPEN_PICKER.with(|open| open.borrow_mut().take()) {
        previous.close();
    }
    OPEN_PICKER.with(|open| *open.borrow_mut() = Some((picker.clone(), delegate)));
    #[allow(deprecated)]
    NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    let bounds = view.bounds();
    let hub = 48.0;
    let anchor = NSRect::new(
        NSPoint::new(
            bounds.size.width / 2.0 - hub,
            bounds.size.height / 2.0 - hub,
        ),
        NSSize::new(hub * 2.0, hub * 2.0),
    );
    picker.showRelativeToRect_ofView_preferredEdge(anchor, view, NSRectEdge::MaxX);
    Ok(())
}

pub fn copy_files(files: &[PathBuf]) -> Result<(), String> {
    let urls = file_urls(files)?;
    let objects: Vec<&ProtocolObject<dyn NSPasteboardWriting>> = urls
        .iter()
        .map(|url| ProtocolObject::from_ref(&**url))
        .collect();
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    if pasteboard.writeObjects(&NSArray::from_slice(&objects)) {
        Ok(())
    } else {
        Err(i18n::t("share.clipboardRefused"))
    }
}

/// Dossiers des services en ligne (`~/Library/CloudStorage`), puis iCloud Drive.
pub fn cloud_folders() -> Vec<CloudFolder> {
    let Some(home) = home() else {
        return Vec::new();
    };
    let mut entries: Vec<(String, String)> = std::fs::read_dir(home.join("Library/CloudStorage"))
        .map(|dir| {
            dir.flatten()
                .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
                .map(|name| {
                    let (provider, account) = name.split_once('-').unwrap_or((&name, ""));
                    (provider.to_owned(), account.to_owned())
                })
                .collect()
        })
        .unwrap_or_default();
    entries.sort();

    let mut folders = Vec::new();
    for (provider, account) in &entries {
        let Some((name, inner, app)) = provider_details(provider, account) else {
            continue;
        };
        let mut dir = home
            .join("Library/CloudStorage")
            .join(if account.is_empty() {
                provider.clone()
            } else {
                format!("{provider}-{account}")
            });
        if let Some(inner) = inner
            && dir.join(inner).is_dir()
        {
            dir = dir.join(inner);
        }
        // Deux comptes du même service : on les distingue par le compte
        let twice = entries
            .iter()
            .filter(|(other, _)| other == provider)
            .count()
            > 1;
        folders.push(CloudFolder {
            name: if twice && !account.is_empty() {
                format!("{name} ({account})")
            } else {
                name
            },
            path: dir,
            icon: app.map(PathBuf::from).filter(|app| app.exists()),
        });
    }

    let icloud = home.join("Library/Mobile Documents/com~apple~CloudDocs");
    if icloud.is_dir() {
        folders.push(CloudFolder {
            name: "iCloud Drive".into(),
            path: icloud,
            icon: Some(PathBuf::from(FINDER_APPS).join("iCloud Drive.app")),
        });
    }
    folders
}

/// Nom affiché, sous-dossier où copier et app du service, d'après le nom du dossier dans
/// `~/Library/CloudStorage` (« GoogleDrive-moi@gmail.com », « OneDrive-Personal »…).
fn provider_details(
    provider: &str,
    account: &str,
) -> Option<(String, Option<&'static str>, Option<&'static str>)> {
    Some(match provider {
        "GoogleDrive" => (
            "Google Drive".into(),
            Some("My Drive"),
            Some("/Applications/Google Drive.app"),
        ),
        "Dropbox" => ("Dropbox".into(), None, Some("/Applications/Dropbox.app")),
        // Les bibliothèques partagées d'une entreprise ne sont pas un endroit où déposer
        "OneDrive" if account.starts_with("SharedLibraries") => return None,
        "OneDrive" => ("OneDrive".into(), None, Some("/Applications/OneDrive.app")),
        "Box" => ("Box".into(), None, Some("/Applications/Box.app")),
        _ if provider.starts_with('.') => return None,
        _ => (provider.to_owned(), None, None),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liste_les_services_du_systeme() {
        let services = services();
        let airdrop = services
            .iter()
            .find(|service| service.id == super::super::AIRDROP);
        assert!(airdrop.is_some(), "AirDrop absent : {services:?}");
        assert!(airdrop.unwrap().icon.is_some(), "icône d'AirDrop absente");
    }

    #[test]
    fn reconnait_les_services_en_ligne() {
        let google = provider_details("GoogleDrive", "moi@gmail.com").unwrap();
        assert_eq!(google.0, "Google Drive");
        assert_eq!(google.1, Some("My Drive"));
        assert!(provider_details("OneDrive", "SharedLibraries-Entreprise").is_none());
        assert_eq!(provider_details("pCloud", "").unwrap().0, "pCloud");
    }
}
