//! Réglages enregistrés dans `settings.json`, dans le dossier de configuration de l'app,
//! et appliqués dès qu'ils changent.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use converter::Quality;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as _;

use super::apps::{self, AppSlot, AppView, MIN_SLOTS};
use super::shake::{self, ShakeSettings};
use super::share::{self, ShareTarget, ShareView};
use super::{shortcut, tray};

pub const SETTINGS_LABEL: &str = "settings";
/// Formats de sortie des roues de conversion, auxquels on peut donner une couleur.
const COLORED_FORMATS: [&str; 12] = [
    "png", "jpeg", "webp", "avif", "svg", "ico", "mp4", "webm", "mov", "mkv", "gif", "mp3",
];
/// Temps à passer au centre, un fichier glissé, avant de basculer entre conversion et partage.
const DEFAULT_DWELL_MS: u32 = 1000;
const DWELL_RANGE_MS: (u32, u32) = (400, 2500);
/// Onglet à afficher, quand la fenêtre de réglages est déjà ouverte.
const TAB_EVENT: &str = "settings://tab";

/// Les roues entre lesquelles le clic au centre fait passer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WheelMode {
    Image,
    Video,
    Apps,
    Share,
}

impl WheelMode {
    const ALL: [WheelMode; 4] = [
        WheelMode::Image,
        WheelMode::Video,
        WheelMode::Apps,
        WheelMode::Share,
    ];
}

/// Contour du disque de la roue.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WheelBorder {
    Dark,
    None,
    /// Le trait gris clair d'origine. Une valeur inconnue (version plus récente, fichier
    /// modifié à la main) se lit comme lui, sans faire perdre les autres réglages ; serde
    /// veut cette variante en dernier.
    #[default]
    #[serde(other)]
    Light,
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
    /// La roue se rouvre sur celle affichée à la fermeture, plutôt que sur la première.
    pub remember_wheel: bool,
    /// Millisecondes au centre, un fichier glissé, avant de basculer entre conversion et partage.
    pub dwell_ms: u32,
    /// Couleur choisie par format (« png » → « #3b82f6 ») ; un format absent garde la sienne.
    pub format_colors: BTreeMap<String, String>,
    /// Couleur de la part survolée ; absente, le bleu d'origine.
    pub highlight_color: Option<String>,
    pub wheel_border: WheelBorder,
    /// Une app (ou rien) par part, dans le sens horaire depuis le haut.
    pub apps: Vec<Option<AppSlot>>,
    /// Une destination (ou rien) par part. Vide tant que la roue de partage n'a jamais été
    /// réglée : elle reçoit alors les destinations trouvées sur la machine.
    pub share: Vec<Option<ShareTarget>>,
    /// Chercher les nouvelles versions au lancement puis régulièrement, et les proposer.
    pub auto_update: bool,
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
            remember_wheel: false,
            dwell_ms: DEFAULT_DWELL_MS,
            format_colors: BTreeMap::new(),
            highlight_color: None,
            wheel_border: WheelBorder::Light,
            apps: vec![None; MIN_SLOTS],
            share: Vec::new(),
            auto_update: true,
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
        apps::fit_slots(&mut self.apps);
        // Vide : les suggestions du premier lancement le rempliront
        if !self.share.is_empty() {
            apps::fit_slots(&mut self.share);
        }
        self.dwell_ms = self.dwell_ms.clamp(DWELL_RANGE_MS.0, DWELL_RANGE_MS.1);
        // Seulement des formats connus, en « #rrggbb » minuscules
        self.format_colors = std::mem::take(&mut self.format_colors)
            .into_iter()
            .filter(|(format, _)| COLORED_FORMATS.contains(&format.as_str()))
            .filter_map(|(format, color)| Some((format, hex_color(&color)?)))
            .collect();
        self.highlight_color = self.highlight_color.as_deref().and_then(hex_color);
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

/// Couleur au format `#rrggbb`, en minuscules ; `None` pour tout le reste.
fn hex_color(value: &str) -> Option<String> {
    let digits = value.trim().strip_prefix('#')?;
    (digits.len() == 6 && digits.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| format!("#{}", digits.to_ascii_lowercase()))
}

pub struct SettingsState(Mutex<Settings>);

fn file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("settings.json"))
}

/// Lit les réglages enregistrés et les garde en mémoire ; un fichier absent ou abîmé
/// redonne les valeurs par défaut.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    let mut settings = file(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .unwrap_or_default();
    if settings.share.is_empty() {
        settings.share = share::suggestions(app);
    }
    let settings = settings.sanitized();
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
    /// macOS : autorisation Accessibilité, pour les pastilles des apps fermées.
    dock_access: Option<bool>,
    platform: &'static str,
    version: String,
    /// Apps des parts, avec leurs icônes.
    apps: Vec<Option<AppView>>,
    /// Destinations de la roue de partage, avec leurs icônes.
    share: Vec<Option<ShareView>>,
    /// Onglet demandé à l'ouverture de la fenêtre (une part vide de la roue, par exemple).
    tab: Option<String>,
}

fn view<R: Runtime>(app: &AppHandle<R>) -> SettingsView {
    let settings = current(app);
    SettingsView {
        apps: apps::views(app, &settings.apps),
        share: share::views(app, &settings.share),
        tab: None,
        shortcut_label: shortcut::label(&settings.shortcut),
        settings,
        default_shortcut: shortcut::DEFAULT_SHORTCUT,
        shortcuts_supported: platform::session::global_shortcuts_supported(),
        wayland: platform::session::is_wayland_session(),
        launch_at_login: app.autolaunch().is_enabled().unwrap_or(false),
        finder_permission: finder_permission(),
        dock_access: apps::dock_access(),
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
    let tab = app
        .try_state::<PendingTab>()
        .and_then(|pending| pending.0.lock().unwrap().take());
    SettingsView { tab, ..view(&app) }
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
    if applied.modes != previous.modes
        || applied.remember_wheel != previous.remember_wheel
        || applied.dwell_ms != previous.dwell_ms
        || applied.format_colors != previous.format_colors
        || applied.highlight_color != previous.highlight_color
        || applied.wheel_border != previous.wheel_border
        || applied.apps != previous.apps
        || applied.share != previous.share
    {
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

/// Volet des Réglages Système où se donne une autorisation.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionPane {
    /// Lire la sélection du Finder.
    Automation,
    /// Lire les pastilles du Dock.
    Accessibility,
}

/// macOS : ouvre le volet des Réglages Système où se donne l'autorisation `pane`.
#[tauri::command]
pub fn open_permission_settings<R: Runtime>(
    app: AppHandle<R>,
    pane: PermissionPane,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_opener::OpenerExt;
        let url = match pane {
            PermissionPane::Automation => platform::selection::AUTOMATION_SETTINGS_URL,
            PermissionPane::Accessibility => platform::apps::ACCESSIBILITY_SETTINGS_URL,
        };
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|err| err.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, pane);
        Ok(())
    }
}

/// Onglet demandé avant que la fenêtre de réglages existe ; elle le lit à son chargement.
#[derive(Default)]
struct PendingTab(Mutex<Option<String>>);

/// Ouvre la fenêtre de réglages, ou la ramène devant si elle l'est déjà, sur l'onglet `tab`
/// s'il est donné.
pub fn open_window<R: Runtime>(app: &AppHandle<R>, tab: Option<&str>) {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        if let Some(tab) = tab {
            let _ = window.emit_to(SETTINGS_LABEL, TAB_EVENT, tab);
        }
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    if app.try_state::<PendingTab>().is_none() {
        app.manage(PendingTab::default());
    }
    *app.state::<PendingTab>().0.lock().unwrap() = tab.map(str::to_owned);
    let built =
        WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App("index.html".into()))
            .title("Réglages de Rutile")
            .inner_size(480.0, 640.0)
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
            share: vec![None; 14],
            ..Settings::default()
        }
        .sanitized();
        let order: Vec<WheelMode> = settings.modes.iter().map(|entry| entry.id).collect();
        assert_eq!(
            order,
            [
                WheelMode::Apps,
                WheelMode::Image,
                WheelMode::Video,
                WheelMode::Share
            ]
        );
        assert_eq!(
            settings.enabled_modes(),
            [WheelMode::Video, WheelMode::Share]
        );
        assert_eq!(settings.apps.len(), MIN_SLOTS);
        assert_eq!(settings.share.len(), apps::MAX_SLOTS);
        let nine = Settings {
            apps: vec![None; 9],
            ..Settings::default()
        }
        .sanitized();
        assert_eq!(
            nine.apps.len(),
            9,
            "entre six et dix emplacements, rien ne change"
        );

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
    fn seules_les_couleurs_valides_sont_gardees() {
        let settings = Settings {
            format_colors: BTreeMap::from([
                ("png".into(), "#FF8800".into()),
                ("webp".into(), "vert".into()),
                ("bmp".into(), "#000000".into()),
            ]),
            highlight_color: Some("#12345".into()),
            dwell_ms: 10,
            ..Settings::default()
        }
        .sanitized();
        assert_eq!(
            settings.format_colors,
            BTreeMap::from([("png".into(), "#ff8800".into())])
        );
        assert_eq!(settings.highlight_color, None);
        assert_eq!(settings.dwell_ms, DWELL_RANGE_MS.0);
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

    #[test]
    fn un_contour_inconnu_redevient_le_contour_clair() {
        let read = |json: &str| serde_json::from_str::<Settings>(json).unwrap();
        let settings = read(r#"{ "wheelBorder": "dark", "jpegQuality": 75 }"#);
        assert_eq!(settings.wheel_border, WheelBorder::Dark);
        let settings = read(r#"{ "wheelBorder": "arc-en-ciel", "jpegQuality": 75 }"#);
        assert_eq!(settings.wheel_border, WheelBorder::Light);
        assert_eq!(settings.jpeg_quality, 75);
        assert_eq!(
            serde_json::to_value(WheelBorder::None).unwrap(),
            serde_json::json!("none")
        );
    }
}
