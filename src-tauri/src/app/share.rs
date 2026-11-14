//! Roue de partage : chaque part envoie les fichiers à un service du système (AirDrop,
//! Messages…), les copie dans un dossier synchronisé (Google Drive, iCloud Drive…), ou les
//! met dans le presse-papiers et ouvre une messagerie sans extension de partage (Signal).

use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, mpsc};

use platform::share::{AIRDROP, MAIL, MESSAGES, Service};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use super::apps;
use super::notify::{self, Action, Message};
use super::settings;
#[cfg(target_os = "macos")]
use super::wheel::WHEEL_LABEL;

/// Garde-fou contre une boucle infinie si le dossier refuse toute création.
const MAX_ATTEMPTS: u32 = 10_000;

/// Destination d'une part, telle qu'enregistrée dans les réglages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ShareTarget {
    /// Service du système (macOS), par son identifiant.
    Service { id: String, name: String },
    /// Dossier où copier les fichiers, synchronisé ou non.
    Folder { path: PathBuf, name: String },
    /// Messagerie qui reçoit les fichiers par le presse-papiers.
    App { path: PathBuf, name: String },
    /// Menu de partage du système (macOS) : on y choisit l'app, puis le destinataire.
    System { name: String },
}

/// Destination « menu de partage du système », nommée dans la langue en cours.
fn share_menu_target() -> ShareTarget {
    ShareTarget::System {
        name: i18n::t("share.menuName"),
    }
}

/// Destination telle que l'interface l'affiche, avec son icône.
#[derive(Debug, Clone, Serialize)]
pub struct ShareView {
    #[serde(flatten)]
    target: ShareTarget,
    /// PNG en data URL.
    icon: Option<String>,
}

/// Services du système, listés une seule fois : chaque liste rend aussi toutes les icônes.
#[derive(Default)]
struct ServiceList(Mutex<Option<Vec<Service>>>);

fn services<R: Runtime>(app: &AppHandle<R>) -> Vec<Service> {
    if app.try_state::<ServiceList>().is_none() {
        app.manage(ServiceList::default());
    }
    let state = app.state::<ServiceList>();
    let mut list = state.0.lock().unwrap();
    list.get_or_insert_with(platform::share::services).clone()
}

/// Relit les services, pour qu'une extension installée depuis le lancement apparaisse.
fn refresh_services<R: Runtime>(app: &AppHandle<R>) -> Vec<Service> {
    let fresh = platform::share::services();
    if app.try_state::<ServiceList>().is_none() {
        app.manage(ServiceList::default());
    }
    *app.state::<ServiceList>().0.lock().unwrap() = Some(fresh.clone());
    fresh
}

fn icon<R: Runtime>(app: &AppHandle<R>, target: &ShareTarget) -> Option<String> {
    match target {
        ShareTarget::Service { id, .. } => apps::cached_icon(app, format!("service:{id}"), || {
            services(app)
                .into_iter()
                .find(|service| &service.id == id)?
                .icon
        }),
        // Un dossier synchronisé prend l'icône de son service (l'app Google Drive…)
        ShareTarget::Folder { path, .. } => {
            apps::cached_icon(app, format!("dossier:{}", path.display()), || {
                let source = platform::share::cloud_folders()
                    .into_iter()
                    .find(|folder| &folder.path == path)
                    .and_then(|folder| folder.icon);
                apps::file_png(source.as_deref().unwrap_or(path))
            })
        }
        ShareTarget::App { path, .. } => apps::file_icon(app, path),
        // Dessinée par l'interface
        ShareTarget::System { .. } => None,
    }
}

fn view<R: Runtime>(app: &AppHandle<R>, target: &ShareTarget) -> ShareView {
    ShareView {
        icon: icon(app, target),
        // Le nom enregistré est celui de la langue d'alors : l'interface montre celui d'aujourd'hui
        target: match target {
            ShareTarget::System { .. } => share_menu_target(),
            other => other.clone(),
        },
    }
}

pub fn views<R: Runtime>(
    app: &AppHandle<R>,
    targets: &[Option<ShareTarget>],
) -> Vec<Option<ShareView>> {
    targets
        .iter()
        .map(|target| target.as_ref().map(|target| view(app, target)))
        .collect()
}

fn app_target(path: PathBuf) -> Option<ShareTarget> {
    let name = platform::apps::describe(&path)?.name;
    Some(ShareTarget::App { path, name })
}

fn folder_target(folder: platform::share::CloudFolder) -> ShareTarget {
    ShareTarget::Folder {
        path: folder.path,
        name: folder.name,
    }
}

/// Destinations du premier lancement, d'après ce qui est installé : AirDrop, Messages, une
/// messagerie, les dossiers synchronisés et Mail.
pub fn suggestions<R: Runtime>(app: &AppHandle<R>) -> Vec<Option<ShareTarget>> {
    let services = services(app);
    let service = |id: &str| {
        services
            .iter()
            .find(|service| service.id == id)
            .map(|service| ShareTarget::Service {
                id: service.id.clone(),
                name: service.name.clone(),
            })
    };
    let mut targets: Vec<ShareTarget> = [service(AIRDROP), service(MESSAGES)]
        .into_iter()
        .flatten()
        .collect();
    targets.extend(
        platform::share::messaging_apps()
            .into_iter()
            .find_map(app_target),
    );
    targets.extend(
        platform::share::cloud_folders()
            .into_iter()
            .map(folder_target),
    );
    targets.extend(service(MAIL));
    if platform::share::HAS_SHARE_MENU {
        targets.push(share_menu_target());
    }
    let mut slots: Vec<Option<ShareTarget>> = targets.into_iter().map(Some).collect();
    apps::fit_slots(&mut slots);
    slots
}

/// Destination proposée dans les réglages, rangée par famille.
#[derive(Debug, Serialize)]
pub struct ShareChoice {
    group: String,
    #[serde(flatten)]
    view: ShareView,
}

/// Tout ce qu'on peut mettre sur une part : services, dossiers synchronisés, messageries.
/// Lu hors du thread principal, que la fenêtre de réglages ne fige pas pendant ce temps.
#[tauri::command]
pub async fn share_choices<R: Runtime>(app: AppHandle<R>) -> Vec<ShareChoice> {
    tauri::async_runtime::spawn_blocking(move || choices(&app))
        .await
        .unwrap_or_default()
}

fn choices<R: Runtime>(app: &AppHandle<R>) -> Vec<ShareChoice> {
    let system = i18n::t("share.group.system");
    let menu = platform::share::HAS_SHARE_MENU.then(|| (system.clone(), share_menu_target()));
    let services = refresh_services(app).into_iter().map(|service| {
        let target = ShareTarget::Service {
            id: service.id,
            name: service.name,
        };
        (system.clone(), target)
    });
    let folders = platform::share::cloud_folders()
        .into_iter()
        .map(|folder| (i18n::t("share.group.folders"), folder_target(folder)));
    let messaging = platform::share::messaging_apps()
        .into_iter()
        .filter_map(app_target)
        .map(|target| (i18n::t("share.group.messaging"), target));
    menu.into_iter()
        .chain(services)
        .chain(folders)
        .chain(messaging)
        .map(|(group, target)| ShareChoice {
            group,
            view: view(app, &target),
        })
        .collect()
}

/// Sélecteur de dossier ; `None` si l'utilisateur annule.
#[tauri::command]
pub async fn pick_share_folder<R: Runtime>(app: AppHandle<R>) -> Option<ShareView> {
    let dialog = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .dialog()
            .file()
            .set_title(i18n::t("share.pickFolder"))
            .blocking_pick_folder()?
            .into_path()
            .ok()
    })
    .await
    .ok()
    .flatten()?;
    tauri::async_runtime::spawn_blocking(move || {
        let name = platform::apps::describe(&path)
            .map(|described| described.name)
            .unwrap_or_else(|| platform::share::folder_name(&path));
        view(&app, &ShareTarget::Folder { path, name })
    })
    .await
    .ok()
}

/// Exécute `task` sur le thread principal, où macOS exige AppKit, et attend son résultat.
async fn on_main_thread<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(task());
    })
    .map_err(|err| err.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?
}

/// Partage les fichiers avec la destination de la part `slot`.
#[tauri::command]
pub async fn share_files<R: Runtime>(
    app: AppHandle<R>,
    slot: usize,
    paths: Vec<PathBuf>,
) -> Result<(), String> {
    let Some(Some(target)) = settings::current(&app).share.get(slot).cloned() else {
        return Err(i18n::t("share.noTarget"));
    };
    let result = share_with(&app, target, paths).await;
    if let Err(err) = &result {
        notify::announce(
            &app,
            Message {
                title: i18n::t("share.failed"),
                body: err.clone(),
                action: None,
            },
            false,
        );
    }
    result
}

async fn share_with<R: Runtime>(
    app: &AppHandle<R>,
    target: ShareTarget,
    paths: Vec<PathBuf>,
) -> Result<(), String> {
    match target {
        ShareTarget::Service { id, .. } => {
            on_main_thread(app, move || platform::share::share(&id, &paths)).await
        }
        ShareTarget::Folder { path, name } => {
            // Un clic sans fichier ouvre simplement le dossier
            if paths.is_empty() {
                return app
                    .opener()
                    .open_path(path.to_string_lossy(), None::<&str>)
                    .map_err(|err| err.to_string());
            }
            let report = tauri::async_runtime::spawn_blocking(move || copy_all(&paths, &path))
                .await
                .map_err(|err| err.to_string())?;
            if report.copied.is_empty() {
                return Err(report.errors.join("\n"));
            }
            // Le Finder montre les copies, sélectionnées dans le dossier
            app.opener()
                .reveal_items_in_dir(&report.copied)
                .map_err(|err| err.to_string())?;
            if !report.errors.is_empty() {
                notify::announce(app, report.message(&name), false);
            }
            Ok(())
        }
        ShareTarget::System { .. } => show_share_menu(app, paths).await,
        ShareTarget::App { path, name } => {
            on_main_thread(app, move || platform::share::copy_files(&paths)).await?;
            tauri::async_runtime::spawn_blocking(move || platform::apps::launch(&path, &[]))
                .await
                .map_err(|err| err.to_string())??;
            notify::announce(
                app,
                Message {
                    title: i18n::tf("share.readyToPaste", &[("name", &name)]),
                    body: i18n::tf("share.pasteHint", &[("shortcut", &PASTE)]),
                    action: None,
                },
                true,
            );
            Ok(())
        }
    }
}

/// Ouvre le menu de partage près du centre de la roue, et attend qu'un service y soit choisi
/// ou qu'il se referme : la roue reste ouverte tant que le menu l'est.
#[cfg(target_os = "macos")]
async fn show_share_menu<R: Runtime>(
    app: &AppHandle<R>,
    paths: Vec<PathBuf>,
) -> Result<(), String> {
    let window = app
        .get_webview_window(WHEEL_LABEL)
        .ok_or_else(|| i18n::t("share.wheelWindowMissing"))?;
    let (sender, receiver) = mpsc::channel();
    on_main_thread(app, move || {
        let view = window.ns_view().map_err(|err| err.to_string())?;
        let done = Box::new(move |chosen: bool| {
            let _ = sender.send(chosen);
        });
        platform::share::show_picker(view, &paths, done)
    })
    .await?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|err| err.to_string())?
        .map(|_chosen| ())
        .map_err(|_| i18n::t("share.menuClosed"))
}

#[cfg(not(target_os = "macos"))]
async fn show_share_menu<R: Runtime>(
    _app: &AppHandle<R>,
    _paths: Vec<PathBuf>,
) -> Result<(), String> {
    Err(i18n::t("share.noMenu"))
}

#[cfg(target_os = "macos")]
const PASTE: &str = "⌘V";
#[cfg(not(target_os = "macos"))]
const PASTE: &str = "Ctrl+V";

struct CopyReport {
    copied: Vec<PathBuf>,
    errors: Vec<String>,
}

impl CopyReport {
    /// Notification d'une copie en partie ratée : combien sont passés, puis les erreurs.
    fn message(&self, folder: &str) -> Message {
        let title = i18n::tn(
            "share.copied",
            self.copied.len() as u64,
            &[("folder", &folder)],
        );
        Message {
            title,
            body: self.errors.join("\n"),
            action: Some(Action::Reveal(self.copied.clone())),
        }
    }
}

fn copy_all(paths: &[PathBuf], folder: &Path) -> CopyReport {
    let mut report = CopyReport {
        copied: Vec::new(),
        errors: Vec::new(),
    };
    for path in paths {
        match copy_into(path, folder) {
            Ok(copy) => report.copied.push(copy),
            Err(err) => report.errors.push(i18n::tf(
                "files.failureLine",
                &[
                    (
                        "name",
                        &path.file_name().unwrap_or_default().to_string_lossy(),
                    ),
                    ("reason", &err),
                ],
            )),
        }
    }
    report
}

/// Nom du `attempt`-ième essai : `photo.png`, puis `photo-1.png`, `photo-2.png`…
fn numbered(source: &Path, attempt: u32, is_dir: bool) -> Option<String> {
    let name = source.file_name()?.to_string_lossy().into_owned();
    if attempt == 0 {
        return Some(name);
    }
    let extension = (!is_dir)
        .then(|| source.extension())
        .flatten()
        .map(|extension| extension.to_string_lossy());
    Some(match extension {
        Some(extension) => {
            let stem = source.file_stem()?.to_string_lossy();
            format!("{stem}-{attempt}.{extension}")
        }
        None => format!("{name}-{attempt}"),
    })
}

/// Copie un fichier ou un dossier dans `folder`, sans jamais rien écraser.
fn copy_into(source: &Path, folder: &Path) -> io::Result<PathBuf> {
    let is_dir = source.is_dir();
    for attempt in 0..MAX_ATTEMPTS {
        let name = numbered(source, attempt, is_dir).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, i18n::t("share.emptyName"))
        })?;
        let target = folder.join(name);
        // Le nom est réservé de façon atomique, même si un autre programme écrit en même temps
        let reserved = if is_dir {
            fs::create_dir(&target)
        } else {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map(drop)
        };
        match reserved {
            Ok(()) => {
                let copied = if is_dir {
                    copy_dir_contents(source, &target)
                } else {
                    fs::copy(source, &target).map(drop)
                };
                if let Err(err) = copied {
                    let _ = if is_dir {
                        fs::remove_dir_all(&target)
                    } else {
                        fs::remove_file(&target)
                    };
                    return Err(err);
                }
                return Ok(target);
            }
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(io::Error::other(i18n::t("output.noFileName")))
}

fn copy_dir_contents(source: &Path, target: &Path) -> io::Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let destination = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            fs::create_dir(&destination)?;
            copy_dir_contents(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), &destination)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn une_destination_garde_sa_forme_dans_les_reglages() {
        let target = ShareTarget::Service {
            id: AIRDROP.into(),
            name: "AirDrop".into(),
        };
        let json = serde_json::to_string(&target).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"service","id":"com.apple.share.AirDrop.send","name":"AirDrop"}"#
        );
        assert_eq!(serde_json::from_str::<ShareTarget>(&json).unwrap(), target);
    }

    #[test]
    fn les_copies_sont_numerotees_sans_perdre_l_extension() {
        let photo = Path::new("/images/photo.png");
        assert_eq!(numbered(photo, 0, false).unwrap(), "photo.png");
        assert_eq!(numbered(photo, 2, false).unwrap(), "photo-2.png");
        assert_eq!(
            numbered(Path::new("/docs/Projet.v2"), 1, true).unwrap(),
            "Projet.v2-1"
        );
    }

    #[test]
    fn copier_deux_fois_ne_remplace_rien() {
        let dir = std::env::temp_dir().join(format!("rutile-partage-{}", std::process::id()));
        let source = dir.join("source");
        let folder = dir.join("drive");
        fs::create_dir_all(source.join("album")).unwrap();
        fs::create_dir_all(&folder).unwrap();
        fs::write(source.join("note.txt"), "bonjour").unwrap();
        fs::write(source.join("album/photo.png"), "image").unwrap();

        let first = copy_into(&source.join("note.txt"), &folder).unwrap();
        let second = copy_into(&source.join("note.txt"), &folder).unwrap();
        assert_eq!(first, folder.join("note.txt"));
        assert_eq!(second, folder.join("note-1.txt"));
        assert_eq!(fs::read_to_string(second).unwrap(), "bonjour");

        let album = copy_into(&source.join("album"), &folder).unwrap();
        assert_eq!(
            fs::read_to_string(album.join("photo.png")).unwrap(),
            "image"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
