//! Réglages enregistrés dans `settings.json`, dans le dossier de configuration de l'app,
//! et appliqués dès qu'ils changent.

use std::path::PathBuf;
use std::sync::Mutex;

use converter::Quality;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as _;

use super::apps::{self, APP_SLOTS, AppSlot, AppView};
use super::shake::{self, ShakeSettings};
use super::{shortcut, tray};

pub const SETTINGS_LABEL: &str = "settings";

/// Les roues entre lesquelles le clic au centre fait passer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WheelMode {
    Image,
    Video,
    Apps,
}

impl WheelMode {
    const ALL: [WheelMode; 3] = [WheelMode::Image, WheelMode::Video, WheelMode::Apps];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModeEntry {
    pub id: WheelMode,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub shortcut: String,
    pub shake_enabled: bool,
    pub shake_sensitivity: u8,
    pub jpeg_quality: u8,
    pub webp_quality: u8,
    pub avif_quality: u8,
    /// Ordre du clic au centre, et roues affichées ou non.
    pub modes: Vec<ModeEntry>,
    /// Une app (ou rien) par part, dans le sens horaire depuis le haut.
    pub apps: Vec<Option<AppSlot>>,
}

impl Default for Settings {
    fn default() -> Self {
        let shake = ShakeSettings::default();
        let quality = Quality::default();
        Settings {
            shortcut: shortcut::DEFAULT_SHORTCUT.into(),
            shake_enabled: shake.enabled,
            shake_sensitivity: shake.sensitivity,
            jpeg_quality: quality.jpeg,
            webp_quality: quality.webp,
            avif_quality: quality.avif,
            modes: WheelMode::ALL
                .map(|id| ModeEntry { id, enabled: true })
                .to_vec(),
            apps: vec![None; APP_SLOTS],
        }
    }
}

impl Settings {
    /// Ramène chaque valeur dans ses bornes (fichier modifié à la main, ancienne version).
    fn sanitized(mut self) -> Self {
        self.shake_sensitivity = self.shake_sensitivity.clamp(1, 10);
        for quality in [
            &mut self.jpeg_quality,
            &mut self.webp_quality,
            &mut self.avif_quality,
        ] {
            *quality = (*quality).clamp(1, 100);
        }
        if self.shortcut.trim().is_empty() {
            self.shortcut = shortcut::DEFAULT_SHORTCUT.into();
        }
        // Chaque roue une seule fois, les absentes ajoutées à la fin, et au moins une active
        let mut modes: Vec<ModeEntry> = Vec::new();
        for entry in self.modes {
            if !modes.iter().any(|known| known.id == entry.id) {
                modes.push(entry);
            }
        }
        for id in WheelMode::ALL {
            if !modes.iter().any(|known| known.id == id) {
                modes.push(ModeEntry { id, enabled: true });
            }
        }
        if !modes.iter().any(|entry| entry.enabled) {
            modes[0].enabled = true;
        }
        self.modes = modes;
        self.apps.resize(APP_SLOTS, None);
        self
    }

    pub fn enabled_modes(&self) -> Vec<WheelMode> {
        self.modes
            .iter()
            .filter(|entry| entry.enabled)
            .map(|entry| entry.id)
            .collect()
    }

    pub fn quality(&self) -> Quality {
        Quality {
            jpeg: self.jpeg_quality,
            webp: self.webp_quality,
            avif: self.avif_quality,
        }
    }

    pub fn shake(&self) -> ShakeSettings {
        ShakeSettings {
            enabled: self.shake_enabled,
            sensitivity: self.shake_sensitivity,
        }
    }
}

pub struct SettingsState(Mutex<Settings>);

fn file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("settings.json"))
}

/// Lit les réglages enregistrés et les garde en mémoire ; un fichier absent ou abîmé
/// redonne les valeurs par défaut.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    let settings = file(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .unwrap_or_default()
        .sanitized();
    app.manage(SettingsState(Mutex::new(settings.clone())));
    settings
}

pub fn current<R: Runtime>(app: &AppHandle<R>) -> Settings {
    app.state::<SettingsState>().0.lock().unwrap().clone()
}

fn save<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> Result<(), String> {
    let path = file(app).ok_or("dossier de configuration introuvable")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    // Écrit à côté puis renomme : un arrêt brutal ne laisse pas un fichier à moitié écrit
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, text).map_err(|err| err.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|err| err.to_string())
}

/// Ce que la fenêtre de réglages affiche : les valeurs et ce que le système permet.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    settings: Settings,
    shortcut_label: String,
    default_shortcut: &'static str,
    shortcuts_supported: bool,
    wayland: bool,
    launch_at_login: bool,
    /// macOS : autorisation de lire la sélection du Finder.
    finder_permission: Option<&'static str>,
    platform: &'static str,
    version: String,
    /// Apps des parts, avec leurs icônes.
    apps: Vec<Option<AppView>>,
}

fn view<R: Runtime>(app: &AppHandle<R>) -> SettingsView {
    let settings = current(app);
    SettingsView {
        apps: apps::views(app, &settings.apps),
        shortcut_label: shortcut::label(&settings.shortcut),
        settings,
        default_shortcut: shortcut::DEFAULT_SHORTCUT,
        shortcuts_supported: platform::session::global_shortcuts_supported(),
        wayland: platform::session::is_wayland_session(),
        launch_at_login: app.autolaunch().is_enabled().unwrap_or(false),
        finder_permission: finder_permission(),
        platform: std::env::consts::OS,
        version: app.package_info().version.to_string(),
    }
}

fn finder_permission() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        use platform::selection::AutomationPermission;
        Some(match platform::selection::finder_automation_permission() {
            AutomationPermission::Granted => "granted",
            AutomationPermission::Denied => "denied",
            AutomationPermission::NotAsked => "notAsked",
            AutomationPermission::Unknown => "unknown",
        })
    }
    #[cfg(not(target_os = "macos"))]
    None
}

#[tauri::command]
pub fn get_settings<R: Runtime>(app: AppHandle<R>) -> SettingsView {
    view(&app)
}

/// Applique puis enregistre. Un raccourci refusé ou un secouage impossible est signalé,
/// et l'ancienne valeur reste en place.
#[tauri::command]
pub fn update_settings<R: Runtime>(
    app: AppHandle<R>,
    settings: Settings,
) -> Result<SettingsView, String> {
    let wanted = settings.sanitized();
    let previous = current(&app);
    let mut applied = wanted.clone();
    let mut problem = None;

    if wanted.shortcut != previous.shortcut {
        match shortcut::replace(&app, &previous.shortcut, &wanted.shortcut) {
            Ok(()) => tray::show_shortcut(&app, &wanted.shortcut),
            Err(err) => {
                applied.shortcut = previous.shortcut.clone();
                problem = Some(err);
            }
        }
    }
    if wanted.shake() != previous.shake()
        && let Err(err) = shake::apply(&app, wanted.shake())
    {
        applied.shake_enabled = false;
        problem = Some(err);
    }

    *app.state::<SettingsState>().0.lock().unwrap() = applied.clone();
    save(&app, &applied)?;
    if applied.modes != previous.modes || applied.apps != previous.apps {
        apps::config_changed(&app);
    }
    match problem {
        Some(err) => Err(err),
        None => Ok(view(&app)),
    }
}

#[tauri::command]
pub fn set_launch_at_login<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|err| err.to_string())?;
    launcher.is_enabled().map_err(|err| err.to_string())
}

/// macOS : volet Automatisation des Réglages Système, pour autoriser la lecture du Finder.
#[tauri::command]
pub fn open_permission_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(platform::selection::AUTOMATION_SETTINGS_URL, None::<&str>)
            .map_err(|err| err.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

/// Ouvre la fenêtre de réglages, ou la ramène devant si elle l'est déjà.
pub fn open_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let built =
        WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App("index.html".into()))
            .title("Réglages de Rutile")
            .inner_size(480.0, 740.0)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .center()
            .focused(true)
            .build();
    match built {
        // Une app sans icône dans le Dock doit passer devant explicitement
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(err) => eprintln!("rutile : fenêtre de réglages impossible : {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_fichier_incomplet_garde_les_valeurs_par_defaut() {
        let settings: Settings = serde_json::from_str(r#"{ "jpegQuality": 75 }"#).unwrap();
        assert_eq!(settings.jpeg_quality, 75);
        assert_eq!(settings.webp_quality, Settings::default().webp_quality);
        assert_eq!(settings.shortcut, shortcut::DEFAULT_SHORTCUT);
    }

    #[test]
    fn chaque_roue_une_fois_et_au_moins_une_active() {
        let settings = Settings {
            modes: vec![
                ModeEntry {
                    id: WheelMode::Apps,
                    enabled: false,
                },
                ModeEntry {
                    id: WheelMode::Apps,
                    enabled: true,
                },
                ModeEntry {
                    id: WheelMode::Image,
                    enabled: false,
                },
            ],
            apps: vec![None; 2],
            ..Settings::default()
        }
        .sanitized();
        let order: Vec<WheelMode> = settings.modes.iter().map(|entry| entry.id).collect();
        assert_eq!(order, [WheelMode::Apps, WheelMode::Image, WheelMode::Video]);
        assert_eq!(settings.enabled_modes(), [WheelMode::Video]);
        assert_eq!(settings.apps.len(), APP_SLOTS);

        let none_enabled = Settings {
            modes: WheelMode::ALL
                .map(|id| ModeEntry { id, enabled: false })
                .to_vec(),
            ..Settings::default()
        }
        .sanitized();
        assert_eq!(none_enabled.enabled_modes(), [WheelMode::Image]);
    }

    #[test]
    fn les_valeurs_hors_bornes_sont_ramenees() {
        let settings = Settings {
            shortcut: "  ".into(),
            shake_sensitivity: 42,
            jpeg_quality: 0,
            ..Settings::default()
        }
        .sanitized();
        assert_eq!(settings.shortcut, shortcut::DEFAULT_SHORTCUT);
        assert_eq!(settings.shake_sensitivity, 10);
        assert_eq!(settings.jpeg_quality, 1);
    }
}
