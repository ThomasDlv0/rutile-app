//! Roue des apps : chaque part lance une app choisie dans les réglages, et un fichier déposé
//! dessus s'ouvre avec elle.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use platform::apps::Icon;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use super::glass;
use super::settings::{self, CustomWheel, FileWheels, PartEntry, PartKind, WheelBorder};
use super::share::{self, ShareView};
use super::sites;
use super::wheel::WHEEL_LABEL;

/// Emplacements des roues des apps et de partage, une part chacun : six au moins, et dix au
/// plus pour que les icônes ne se touchent pas.
pub const MIN_SLOTS: usize = 6;
pub const MAX_SLOTS: usize = 10;
/// Réglages des roues modifiés : la roue relit sa configuration.
const CONFIG_EVENT: &str = "wheel://config";
const ICON_SIZE: u32 = 128;

/// Ce qu'une part de la roue des apps ouvre.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppKind {
    Folder,
    /// Site web : `path` en est l'adresse.
    Url,
    /// Serde veut cette variante en dernier ; les réglages d'avant les dossiers et les sites
    /// n'ont pas ce champ.
    #[default]
    #[serde(other)]
    App,
}

/// App, dossier ou site choisi pour une part, tel qu'enregistré dans les réglages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppSlot {
    pub path: PathBuf,
    pub name: String,
    #[serde(default)]
    pub kind: AppKind,
}

impl AppSlot {
    /// Une adresse doit rester une adresse web : les réglages sont un fichier modifiable.
    pub fn opens_safely(&self) -> bool {
        self.kind != AppKind::Url || self.path.to_str().is_some_and(settings::web_address)
    }
}

/// App telle que l'interface l'affiche, avec son icône.
#[derive(Debug, Clone, Serialize)]
pub struct AppView {
    path: PathBuf,
    name: String,
    kind: AppKind,
    /// PNG en data URL, absent quand le système ne fournit pas d'icône.
    icon: Option<String>,
}

/// Icônes déjà extraites, par app, dossier ou service : les lire prend du temps, et elles
/// servent à chaque ouverture.
#[derive(Default)]
struct IconCache(Mutex<HashMap<String, Option<String>>>);

/// Icône en data URL, lue par `load` la première fois seulement.
pub fn cached_icon<R: Runtime>(
    app: &AppHandle<R>,
    key: String,
    load: impl FnOnce() -> Option<Vec<u8>>,
) -> Option<String> {
    if app.try_state::<IconCache>().is_none() {
        app.manage(IconCache::default());
    }
    let cache = app.state::<IconCache>();
    if let Some(known) = cache.0.lock().unwrap().get(&key) {
        return known.clone();
    }
    let url = load().map(|png| format!("data:image/png;base64,{}", STANDARD.encode(png)));
    cache.0.lock().unwrap().insert(key, url.clone());
    url
}

/// Icône d'une app, ou de n'importe quel fichier sur macOS.
pub fn file_icon<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Option<String> {
    cached_icon(app, format!("fichier:{}", path.display()), || {
        file_png(path)
    })
}

/// Icône en PNG, sans passer par le cache.
pub fn file_png(path: &Path) -> Option<Vec<u8>> {
    match platform::apps::describe(path)?.icon? {
        Icon::Encoded(png) => Some(png),
        Icon::File(file) => converter::icon_png(&std::fs::read(file).ok()?, ICON_SIZE),
    }
}

/// Ramène une liste d'emplacements entre MIN_SLOTS et MAX_SLOTS.
pub fn fit_slots<T: Clone>(slots: &mut Vec<Option<T>>) {
    slots.truncate(MAX_SLOTS);
    if slots.len() < MIN_SLOTS {
        slots.resize(MIN_SLOTS, None);
    }
}

pub fn views<R: Runtime>(app: &AppHandle<R>, slots: &[Option<AppSlot>]) -> Vec<Option<AppView>> {
    slots
        .iter()
        .map(|slot| {
            slot.as_ref().map(|slot| AppView {
                icon: match slot.kind {
                    AppKind::Url => sites::icon(app, &slot.path.to_string_lossy()),
                    AppKind::App | AppKind::Folder => file_icon(app, &slot.path),
                },
                path: slot.path.clone(),
                name: slot.name.clone(),
                kind: slot.kind,
            })
        })
        .collect()
}

/// Ce dont la roue a besoin : les roues actives, dans l'ordre du clic au centre, les apps et
/// les destinations de partage.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WheelConfig {
    /// Roues affichées, dans l'ordre du clic au centre : le nom d'une roue de Rutile, ou
    /// `custom:` suivi de l'identifiant d'une roue personnalisée.
    modes: Vec<String>,
    /// Rouvrir sur la dernière roue affichée.
    remember: bool,
    /// Temps au centre avant de basculer entre conversion et partage.
    dwell_ms: u32,
    /// Couleurs choisies pour les formats, et pour la part survolée.
    colors: BTreeMap<String, String>,
    highlight: Option<String>,
    border: WheelBorder,
    /// Matière du disque : le vrai Liquid Glass, son imitation, ou le disque d'origine.
    glass: &'static str,
    /// Les fenêtres se rangent sur ce système.
    window_layout: bool,
    custom: Vec<CustomWheelView>,
    /// Ordre des parts de la roue Actions.
    action_parts: Vec<PartEntry>,
    /// Roue ouverte d'abord et actions proposées, selon le type des fichiers.
    file_wheels: FileWheels,
    apps: Vec<Option<AppView>>,
    share: Vec<Option<ShareView>>,
}

/// Roue personnalisée telle que l'interface l'affiche : ni commande, ni adresse, seulement
/// ce qu'il faut pour dessiner ses parts.
#[derive(Debug, Clone, Serialize)]
pub struct CustomWheelView {
    id: String,
    name: String,
    parts: Vec<CustomPartView>,
    extensions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct CustomPartView {
    name: String,
    kind: PartKind,
    /// Format d'une conversion ou identifiant d'une action : l'interface en tire la part.
    value: Option<String>,
    /// Icône d'une app, d'un dossier ou d'un site, en data URL.
    icon: Option<String>,
}

pub fn custom_views<R: Runtime>(
    app: &AppHandle<R>,
    wheels: &[CustomWheel],
) -> Vec<CustomWheelView> {
    wheels
        .iter()
        .map(|wheel| CustomWheelView {
            id: wheel.id.clone(),
            name: wheel.name.clone(),
            parts: wheel
                .parts()
                .iter()
                .map(|part| CustomPartView {
                    name: part.name.clone(),
                    kind: part.kind,
                    value: matches!(part.kind, PartKind::Convert | PartKind::Action)
                        .then(|| part.value.clone()),
                    icon: match part.kind {
                        PartKind::App | PartKind::Folder => file_icon(app, Path::new(&part.value)),
                        PartKind::Url => sites::icon(app, &part.value),
                        _ => None,
                    },
                })
                .collect(),
            extensions: wheel.extensions.clone(),
        })
        .collect()
}

#[tauri::command]
pub fn wheel_config<R: Runtime>(app: AppHandle<R>) -> WheelConfig {
    let settings = settings::current(&app);
    WheelConfig {
        modes: settings.enabled_modes(),
        remember: settings.remember_wheel,
        dwell_ms: settings.dwell_ms,
        colors: settings.format_colors.clone(),
        highlight: settings.highlight_color.clone(),
        border: settings.wheel_border,
        glass: match (settings.wheel_glass, glass::available()) {
            (false, _) => "off",
            (true, true) => "native",
            (true, false) => "css",
        },
        window_layout: platform::placement::supported(),
        custom: custom_views(&app, &settings.custom_wheels),
        action_parts: settings.action_parts.clone(),
        file_wheels: settings.file_wheels.clone(),
        apps: views(&app, &settings.apps),
        share: share::views(&app, &settings.share),
    }
}

pub fn config_changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit_to(WHEEL_LABEL, CONFIG_EVENT, wheel_config(app.clone()));
}

/// Sélecteur d'app (dans Applications sur macOS) ; `None` si l'utilisateur annule.
#[tauri::command]
pub async fn pick_app<R: Runtime>(app: AppHandle<R>) -> Option<AppSlot> {
    let dialog = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (extensions, folder) = platform::apps::picker();
        let mut picker = dialog
            .dialog()
            .file()
            .set_title("Choisir une application")
            .add_filter("Applications", extensions);
        if let Some(folder) = folder {
            picker = picker.set_directory(folder);
        }
        let path = picker.blocking_pick_file()?.into_path().ok()?;
        let name = platform::apps::describe(&path)?.name;
        Some(AppSlot {
            path,
            name,
            kind: AppKind::App,
        })
    })
    .await
    .ok()
    .flatten()
}

/// Sélecteur de dossier pour une part de la roue des apps.
#[tauri::command]
pub async fn pick_app_folder<R: Runtime>(app: AppHandle<R>) -> Option<AppSlot> {
    tauri::async_runtime::spawn_blocking(move || {
        let picker = app.dialog().file().set_title("Choisir un dossier");
        let path = picker.blocking_pick_folder()?.into_path().ok()?;
        let name = path.file_name()?.to_string_lossy().into_owned();
        Some(AppSlot {
            path,
            name,
            kind: AppKind::Folder,
        })
    })
    .await
    .ok()
    .flatten()
}

/// Pastilles de notifications des apps de la roue, dans l'ordre des parts (macOS seulement).
#[tauri::command]
pub async fn app_badges<R: Runtime>(app: AppHandle<R>) -> Vec<Option<String>> {
    let slots = settings::current(&app).apps;
    tauri::async_runtime::spawn_blocking(move || {
        let badges = platform::apps::badges();
        slots
            .iter()
            .map(|slot| {
                slot.as_ref()
                    .and_then(|slot| badges.get(&slot.path).cloned())
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// macOS : Rutile peut-il lire le Dock, et donc les pastilles des apps fermées ? `None`
/// ailleurs.
pub fn dock_access() -> Option<bool> {
    #[cfg(target_os = "macos")]
    return Some(platform::apps::dock_access());
    #[cfg(not(target_os = "macos"))]
    None
}

#[tauri::command]
pub fn dock_badges_allowed() -> Option<bool> {
    dock_access()
}

/// Demande l'autorisation Accessibilité : macOS propose d'ouvrir les Réglages Système. Vrai
/// si elle est déjà accordée.
#[tauri::command]
pub fn allow_dock_badges() -> bool {
    #[cfg(target_os = "macos")]
    return platform::apps::request_dock_access();
    #[cfg(not(target_os = "macos"))]
    false
}

/// Lance l'app de la part `slot`, en lui faisant ouvrir les fichiers déposés.
#[tauri::command]
pub async fn launch_app<R: Runtime>(
    app: AppHandle<R>,
    slot: usize,
    paths: Vec<PathBuf>,
) -> Result<(), String> {
    let Some(Some(chosen)) = settings::current(&app).apps.get(slot).cloned() else {
        return Err("Aucune application n'est associée à cette part.".into());
    };
    match chosen.kind {
        AppKind::App => tauri::async_runtime::spawn_blocking(move || {
            platform::apps::launch(&chosen.path, &paths)
        })
        .await
        .map_err(|err| err.to_string())?,
        AppKind::Folder => app
            .opener()
            .open_path(chosen.path.to_string_lossy(), None::<&str>)
            .map_err(|err| err.to_string()),
        AppKind::Url if chosen.opens_safely() => app
            .opener()
            .open_url(chosen.path.to_string_lossy(), None::<&str>)
            .map_err(|err| err.to_string()),
        AppKind::Url => Err("Seules les adresses web s'ouvrent.".into()),
    }
}

/// Une part vide de la roue ouvre les réglages sur l'onglet où la remplir. Asynchrone : sous
/// Windows, une fenêtre créée depuis une commande synchrone reste blanche et bloque l'app.
#[tauri::command]
pub async fn open_settings<R: Runtime>(app: AppHandle<R>, tab: Option<String>) {
    settings::open_window(&app, tab.as_deref());
}
