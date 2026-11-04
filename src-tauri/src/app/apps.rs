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

use super::settings::{self, WheelMode};
use super::share::{self, ShareView};
use super::wheel::WHEEL_LABEL;

/// Une app par part de la roue.
pub const APP_SLOTS: usize = 6;
/// Réglages des roues modifiés : la roue relit sa configuration.
const CONFIG_EVENT: &str = "wheel://config";
const ICON_SIZE: u32 = 128;

/// App choisie pour une part, telle qu'enregistrée dans les réglages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppSlot {
    pub path: PathBuf,
    pub name: String,
}

/// App telle que l'interface l'affiche, avec son icône.
#[derive(Debug, Clone, Serialize)]
pub struct AppView {
    path: PathBuf,
    name: String,
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

pub fn views<R: Runtime>(app: &AppHandle<R>, slots: &[Option<AppSlot>]) -> Vec<Option<AppView>> {
    slots
        .iter()
        .map(|slot| {
            slot.as_ref().map(|slot| AppView {
                icon: file_icon(app, &slot.path),
                path: slot.path.clone(),
                name: slot.name.clone(),
            })
        })
        .collect()
}

/// Ce dont la roue a besoin : les roues actives, dans l'ordre du clic au centre, les apps et
/// les destinations de partage.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WheelConfig {
    modes: Vec<WheelMode>,
    /// Rouvrir sur la dernière roue affichée.
    remember: bool,
    /// Temps au centre avant de basculer entre conversion et partage.
    dwell_ms: u32,
    /// Couleurs choisies pour les formats, et pour la part survolée.
    colors: BTreeMap<String, String>,
    highlight: Option<String>,
    apps: Vec<Option<AppView>>,
    share: Vec<Option<ShareView>>,
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
        Some(AppSlot { path, name })
    })
    .await
    .ok()
    .flatten()
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
    tauri::async_runtime::spawn_blocking(move || platform::apps::launch(&chosen.path, &paths))
        .await
        .map_err(|err| err.to_string())?
}

/// Une part vide de la roue ouvre les réglages sur l'onglet où la remplir.
#[tauri::command]
pub fn open_settings<R: Runtime>(app: AppHandle<R>, tab: Option<String>) {
    settings::open_window(&app, tab.as_deref());
}
