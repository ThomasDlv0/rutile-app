//! Réglages enregistrés dans `settings.json`, dans le dossier de configuration de l'app,
//! et appliqués dès qu'ils changent.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use converter::Quality;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as _;

use super::apps::{self, AppSlot, AppView, CustomWheelView, MIN_SLOTS};
use super::shake::{self, ShakeSettings};
use super::share::{self, ShareTarget, ShareView};
use super::{shortcut, tray};

pub const SETTINGS_LABEL: &str = "settings";
/// Formats de sortie des roues de conversion, auxquels on peut donner une couleur.
const COLORED_FORMATS: [&str; 21] = [
    "png",
    "jpeg",
    "webp",
    "avif",
    "svg",
    "ico",
    "mp4",
    "webm",
    "mov",
    "mkv",
    "gif",
    "mp3",
    "action-capture",
    "action-text",
    "action-color",
    "action-files",
    "action-image",
    "action-video",
    "action-windows",
    "action-apps",
    "action-custom",
];
/// Formats vers lesquels une part d'une roue personnalisée peut convertir.
const CONVERT_FORMATS: [&str; 12] = [
    "png", "jpeg", "webp", "avif", "svg", "ico", "mp4", "webm", "mov", "mkv", "gif", "mp3",
];
/// Roues personnalisées, et parts par roue.
const MAX_CUSTOM: usize = 10;
/// Longueur du nom d'une roue personnalisée et de son identifiant.
const MAX_WHEEL_NAME: usize = 30;
const MAX_WHEEL_ID: usize = 16;
/// Devant l'identifiant d'une roue personnalisée, dans l'ordre des roues.
const CUSTOM_PREFIX: &str = "custom:";
/// Parts d'une liste réordonnable de la roue Actions, et longueur de leur identifiant.
const MAX_PARTS: usize = 40;
const MAX_PART_ID: usize = 40;
/// Extensions qui limitent une roue personnalisée à certains fichiers.
const MAX_EXTENSIONS: usize = 20;
const MAX_EXTENSION_LEN: usize = 10;
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
    Actions,
}

impl WheelMode {
    const ALL: [WheelMode; 5] = [
        WheelMode::Image,
        WheelMode::Video,
        WheelMode::Apps,
        WheelMode::Share,
        WheelMode::Actions,
    ];

    /// Nom de la roue dans l'ordre des roues, le même que dans les réglages enregistrés.
    fn key(self) -> &'static str {
        match self {
            WheelMode::Image => "image",
            WheelMode::Video => "video",
            WheelMode::Apps => "apps",
            WheelMode::Share => "share",
            WheelMode::Actions => "actions",
        }
    }
}

/// Contour du disque de la roue.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WheelBorder {
    /// Le trait gris clair, le choix par défaut jusqu'à la 1.4.
    Light,
    Dark,
    /// À la couleur `wheel_border_color`. Les versions d'avant la 1.5 le lisent comme le
    /// contour clair.
    Color,
    /// Aucun trait, par défaut. Une valeur inconnue (version plus récente, fichier modifié à
    /// la main) se lit comme lui, sans faire perdre les autres réglages ; serde veut cette
    /// variante en dernier.
    #[default]
    #[serde(other)]
    None,
}

/// Ce que fait une part d'une roue personnalisée.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PartKind {
    /// App à lancer, par son chemin ; les fichiers de la roue s'ouvrent avec elle.
    App,
    /// Dossier à ouvrir.
    Folder,
    /// Adresse d'un site.
    Url,
    /// Conversion vers un format des roues Images et Vidéo (`png`, `mp4`…).
    Convert,
    /// Action de la roue Actions, par son identifiant.
    Action,
    /// Raccourci de l'app Raccourcis (macOS), par son nom.
    Shortcut,
    /// Commande du système ; les fichiers de la roue lui sont passés en arguments.
    Command,
}

impl PartKind {
    /// Les seules parts que connaissent les versions d'avant la 1.4.
    fn legacy(self) -> bool {
        matches!(self, PartKind::Shortcut | PartKind::Command | PartKind::Url)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomPart {
    /// Nom affiché ; celui d'une conversion ou d'une action vient de la roue.
    #[serde(default)]
    pub name: String,
    pub kind: PartKind,
    /// Chemin, adresse, format, identifiant d'action, nom du raccourci ou commande.
    pub value: String,
    /// Couleur choisie pour la part, en « #rrggbb » ; absente, celle de son format ou de son
    /// action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl CustomPart {
    /// Une part doit pouvoir se lancer : les réglages sont un fichier modifiable.
    fn valid(&self) -> bool {
        let value = self.value.trim();
        let named = !self.name.trim().is_empty();
        match self.kind {
            PartKind::App | PartKind::Folder | PartKind::Shortcut | PartKind::Command => {
                named && !value.is_empty()
            }
            PartKind::Url => named && web_address(value),
            PartKind::Convert => CONVERT_FORMATS.contains(&value),
            PartKind::Action => plausible_id(value),
        }
    }
}

fn enabled_by_default() -> bool {
    true
}

/// Liste dont on garde ce qui se lit : une part d'un genre inconnu de cette version (écrite
/// par une plus récente) est écartée sans faire perdre les autres réglages.
fn lenient<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let values = Vec::<serde_json::Value>::deserialize(deserializer)?;
    Ok(readable(values))
}

fn lenient_option<'de, D, T>(deserializer: D) -> Result<Option<Vec<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let values = Option::<Vec<serde_json::Value>>::deserialize(deserializer)?;
    Ok(values.map(readable))
}

fn readable<T: DeserializeOwned>(values: Vec<serde_json::Value>) -> Vec<T> {
    values
        .into_iter()
        .filter_map(|value| serde_json::from_value(value).ok())
        .collect()
}

/// Roue faite par l'utilisateur : elle prend sa place parmi les autres roues.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomWheel {
    /// Identifiant stable, qui la désigne dans l'ordre des roues ; vide, il est attribué.
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// Affichée parmi les roues, au clic sur le centre.
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    /// Parts dans l'ordre. Absentes des réglages d'avant la 1.4 : elles viennent alors
    /// d'`actions`.
    #[serde(default, deserialize_with = "lenient_option")]
    pub parts: Option<Vec<CustomPart>>,
    /// Ce que lisent les versions d'avant la 1.4 : les parts qu'elles connaissent, recopiées
    /// à chaque enregistrement.
    #[serde(default, deserialize_with = "lenient")]
    pub actions: Vec<CustomPart>,
    /// Extensions (`pdf`, `docx`…) des fichiers pour lesquels la roue apparaît ; vide, elle
    /// apparaît toujours.
    #[serde(default)]
    pub extensions: Vec<String>,
}

impl CustomWheel {
    pub fn parts(&self) -> &[CustomPart] {
        self.parts.as_deref().unwrap_or_default()
    }

    /// Clé de la roue dans l'ordre des roues.
    fn key(&self) -> String {
        format!("{CUSTOM_PREFIX}{}", self.id)
    }

    /// Sans part, il n'y a rien à afficher.
    fn shown(&self) -> bool {
        self.enabled && !self.parts().is_empty()
    }
}

/// Part de la roue Actions, ou action proposée pour un type de fichier, à sa place dans la
/// liste. L'interface connaît la liste complète : une part absente s'ajoute à la fin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartEntry {
    pub id: String,
    pub enabled: bool,
}

/// Roue qui s'ouvre d'abord quand arrive un fichier : secoué, glissé ou sélectionné.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FirstWheel {
    /// Le convertisseur d'images ou de vidéos.
    Convert,
    Actions,
    Share,
    Apps,
    /// La première roue de la liste, comme sans fichier. Une valeur inconnue se lit comme elle.
    #[default]
    #[serde(other)]
    Usual,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FileWheel {
    pub first: FirstWheel,
    /// Actions de la roue Actions pour ces fichiers, dans l'ordre des parts.
    pub parts: Vec<PartEntry>,
}

impl FileWheel {
    fn opening(first: FirstWheel) -> Self {
        FileWheel {
            first,
            parts: Vec::new(),
        }
    }
}

/// Par type de fichier : la roue ouverte d'abord, et les actions proposées.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FileWheels {
    pub images: FileWheel,
    pub videos: FileWheel,
    pub pdfs: FileWheel,
    pub archives: FileWheel,
    /// Tout le reste, et les mélanges de types.
    pub others: FileWheel,
}

impl Default for FileWheels {
    /// Images et vidéos vont d'abord au convertisseur, le reste à la roue Actions.
    fn default() -> Self {
        FileWheels {
            images: FileWheel::opening(FirstWheel::Convert),
            videos: FileWheel::opening(FirstWheel::Convert),
            pdfs: FileWheel::opening(FirstWheel::Actions),
            archives: FileWheel::opening(FirstWheel::Actions),
            others: FileWheel::opening(FirstWheel::Actions),
        }
    }
}

/// Identifiant d'une part de la roue Actions tel que l'interface en écrit : `capture-zone`,
/// `image-fullHd`.
fn plausible_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_PART_ID
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Chaque part une seule fois, sous un identifiant plausible.
fn sanitized_parts(parts: Vec<PartEntry>) -> Vec<PartEntry> {
    let mut kept: Vec<PartEntry> = Vec::new();
    for part in parts {
        if plausible_id(&part.id) && !kept.iter().any(|known| known.id == part.id) {
            kept.push(part);
        }
    }
    kept.truncate(MAX_PARTS);
    kept
}

/// Identifiant d'une roue personnalisée : quelques lettres minuscules et chiffres.
fn plausible_wheel_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_WHEEL_ID
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// `.PDF` → `pdf` ; seulement lettres et chiffres, chaque extension une fois.
fn sanitized_extensions(extensions: Vec<String>) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for extension in extensions {
        let extension = extension.trim().trim_start_matches('.').to_lowercase();
        let plausible = !extension.is_empty()
            && extension.len() <= MAX_EXTENSION_LEN
            && extension.chars().all(char::is_alphanumeric);
        if plausible && !kept.contains(&extension) {
            kept.push(extension);
        }
    }
    kept.truncate(MAX_EXTENSIONS);
    kept
}

/// Seules les adresses web s'ouvrent : pas de `file:` ni de `javascript:` depuis la roue.
pub fn web_address(value: &str) -> bool {
    let value = value.trim();
    value.starts_with("https://") || value.starts_with("http://")
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
    /// Roues de Rutile, affichées ou non. Leur ordre suit `wheel_order` : c'est celui que
    /// lisent les versions d'avant la 1.4.
    pub modes: Vec<ModeEntry>,
    /// Ordre du clic au centre, roues personnalisées comprises (`custom:` puis leur
    /// identifiant).
    pub wheel_order: Vec<String>,
    /// La roue se rouvre sur celle affichée à la fermeture, plutôt que sur la première.
    pub remember_wheel: bool,
    /// Millisecondes au centre, un fichier glissé, avant de basculer entre conversion et partage.
    pub dwell_ms: u32,
    /// Couleur choisie par format (« png » → « #3b82f6 ») ; un format absent garde la sienne.
    pub format_colors: BTreeMap<String, String>,
    /// Couleur de la part survolée ; absente, le bleu d'origine.
    pub highlight_color: Option<String>,
    pub wheel_border: WheelBorder,
    /// Couleur du contour « color » ; absente, celle de la surbrillance.
    pub wheel_border_color: Option<String>,
    /// Liquid Glass sur le disque de la roue.
    pub wheel_glass: bool,
    /// Une capture rouvre la roue sur l'image, pour la convertir ou la partager.
    pub capture_reopen: bool,
    /// Roues faites par l'utilisateur.
    pub custom_wheels: Vec<CustomWheel>,
    /// Ordre des parts de la roue Actions, et parts affichées ou non.
    pub action_parts: Vec<PartEntry>,
    /// Roue ouverte d'abord et actions proposées, selon le type des fichiers.
    pub file_wheels: FileWheels,
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
            wheel_order: Vec::new(),
            remember_wheel: false,
            dwell_ms: DEFAULT_DWELL_MS,
            format_colors: BTreeMap::new(),
            highlight_color: None,
            wheel_border: WheelBorder::None,
            wheel_border_color: None,
            wheel_glass: true,
            capture_reopen: true,
            custom_wheels: Vec::new(),
            action_parts: Vec::new(),
            file_wheels: FileWheels::default(),
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
        self.custom_wheels.truncate(MAX_CUSTOM);
        let mut ids: Vec<String> = Vec::new();
        for wheel in &mut self.custom_wheels {
            wheel.name = wheel.name.trim().chars().take(MAX_WHEEL_NAME).collect();
            // Réglages d'avant la 1.4 : les actions deviennent les parts
            let mut parts = wheel
                .parts
                .take()
                .unwrap_or_else(|| std::mem::take(&mut wheel.actions));
            parts.retain(CustomPart::valid);
            for part in &mut parts {
                part.color = part.color.as_deref().and_then(hex_color);
            }
            parts.truncate(MAX_CUSTOM);
            wheel.actions = parts
                .iter()
                .filter(|part| part.kind.legacy())
                .cloned()
                .collect();
            wheel.parts = Some(parts);
            wheel.extensions = sanitized_extensions(std::mem::take(&mut wheel.extensions));
            if !plausible_wheel_id(&wheel.id) || ids.contains(&wheel.id) {
                wheel.id.clear();
            }
            ids.push(wheel.id.clone());
        }
        // Un identifiant manquant ou en double est attribué : « r1 », « r2 »…
        for index in 0..self.custom_wheels.len() {
            if self.custom_wheels[index].id.is_empty() {
                let fresh = (1..)
                    .map(|number| format!("r{number}"))
                    .find(|id| !ids.contains(id))
                    .expect("il reste toujours un numéro libre");
                ids[index] = fresh.clone();
                self.custom_wheels[index].id = fresh;
            }
        }
        // Il faut une roue qui s'affiche quels que soient les fichiers
        let always = self
            .custom_wheels
            .iter()
            .any(|wheel| wheel.shown() && wheel.extensions.is_empty());
        if !modes.iter().any(|entry| entry.enabled) && !always {
            modes[0].enabled = true;
        }
        // Ordre des roues : celui enregistré, puis les roues qu'il ne connaît pas encore
        let mut order: Vec<String> = Vec::new();
        let known = modes
            .iter()
            .map(|entry| entry.id.key().to_owned())
            .chain(self.custom_wheels.iter().map(CustomWheel::key));
        let known: Vec<String> = known.collect();
        for key in std::mem::take(&mut self.wheel_order)
            .into_iter()
            .chain(known.clone())
        {
            if known.contains(&key) && !order.contains(&key) {
                order.push(key);
            }
        }
        modes.sort_by_key(|entry| order.iter().position(|key| key == entry.id.key()));
        self.wheel_order = order;
        self.modes = modes;
        for slot in &mut self.apps {
            if slot.as_ref().is_some_and(|slot| !slot.opens_safely()) {
                *slot = None;
            }
        }
        apps::fit_slots(&mut self.apps);
        self.action_parts = sanitized_parts(std::mem::take(&mut self.action_parts));
        let files = &mut self.file_wheels;
        for (wheel, convertible) in [
            (&mut files.images, true),
            (&mut files.videos, true),
            (&mut files.pdfs, false),
            (&mut files.archives, false),
            (&mut files.others, false),
        ] {
            wheel.parts = sanitized_parts(std::mem::take(&mut wheel.parts));
            // Aucun convertisseur pour ces fichiers : la roue Actions les attend
            if wheel.first == FirstWheel::Convert && !convertible {
                wheel.first = FirstWheel::Actions;
            }
        }
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
        self.wheel_border_color = self.wheel_border_color.as_deref().and_then(hex_color);
        self
    }

    /// Roues affichées, dans l'ordre du clic au centre : le nom d'une roue de Rutile, ou
    /// `custom:` suivi de l'identifiant d'une roue personnalisée.
    pub fn enabled_modes(&self) -> Vec<String> {
        self.wheel_order
            .iter()
            .filter(|key| match key.strip_prefix(CUSTOM_PREFIX) {
                Some(id) => self
                    .custom_wheels
                    .iter()
                    .any(|wheel| wheel.id == id && wheel.shown()),
                None => self
                    .modes
                    .iter()
                    .any(|entry| entry.id.key() == key.as_str() && entry.enabled),
            })
            .cloned()
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

/// Lit des réglages en gardant tout ce qui se lit : un réglage inconnu de cette version
/// (écrit par une plus récente, ou à la main) reprend sa valeur par défaut, sans emporter
/// les autres.
fn parse(text: &str) -> Option<Settings> {
    if let Ok(settings) = serde_json::from_str::<Settings>(text) {
        return Some(settings);
    }
    let serde_json::Value::Object(saved) = serde_json::from_str(text).ok()? else {
        return None;
    };
    let mut kept = serde_json::Map::new();
    for (key, value) in saved {
        let alone = serde_json::Map::from_iter([(key.clone(), value.clone())]);
        if serde_json::from_value::<Settings>(alone.into()).is_ok() {
            kept.insert(key, value);
        }
    }
    serde_json::from_value(kept.into()).ok()
}

/// Lit les réglages enregistrés et les garde en mémoire ; un fichier absent ou abîmé
/// redonne les valeurs par défaut.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    let mut settings = file(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| parse(&text))
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
    /// macOS : autorisation Accessibilité, pour les pastilles et les fenêtres.
    dock_access: Option<bool>,
    /// Le vrai Liquid Glass existe sur ce système.
    native_glass: bool,
    platform: &'static str,
    version: String,
    /// Apps des parts, avec leurs icônes.
    apps: Vec<Option<AppView>>,
    /// Destinations de la roue de partage, avec leurs icônes.
    share: Vec<Option<ShareView>>,
    /// Roues personnalisées, avec les icônes de leurs parts.
    custom: Vec<CustomWheelView>,
    /// Onglet demandé à l'ouverture de la fenêtre (une part vide de la roue, par exemple).
    tab: Option<String>,
}

fn view<R: Runtime>(app: &AppHandle<R>) -> SettingsView {
    let settings = current(app);
    SettingsView {
        apps: apps::views(app, &settings.apps),
        share: share::views(app, &settings.share),
        custom: apps::custom_views(app, &settings.custom_wheels),
        tab: None,
        shortcut_label: shortcut::label(&settings.shortcut),
        settings,
        default_shortcut: shortcut::DEFAULT_SHORTCUT,
        shortcuts_supported: platform::session::global_shortcuts_supported(),
        wayland: platform::session::is_wayland_session(),
        launch_at_login: app.autolaunch().is_enabled().unwrap_or(false),
        finder_permission: finder_permission(),
        dock_access: apps::dock_access(),
        native_glass: super::glass::available(),
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
    if applied.wheel_glass != previous.wheel_glass {
        super::glass::apply(&app, applied.wheel_glass);
    }
    if applied.modes != previous.modes
        || applied.wheel_order != previous.wheel_order
        || applied.remember_wheel != previous.remember_wheel
        || applied.dwell_ms != previous.dwell_ms
        || applied.format_colors != previous.format_colors
        || applied.highlight_color != previous.highlight_color
        || applied.wheel_border != previous.wheel_border
        || applied.wheel_border_color != previous.wheel_border_color
        || applied.wheel_glass != previous.wheel_glass
        || applied.custom_wheels != previous.custom_wheels
        || applied.action_parts != previous.action_parts
        || applied.file_wheels != previous.file_wheels
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
    /// Lire les pastilles du Dock et ranger les fenêtres.
    Accessibility,
    /// Capturer tout l'écran.
    Screen,
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
            PermissionPane::Screen => platform::capture::SCREEN_SETTINGS_URL,
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

    fn part(kind: PartKind, name: &str, value: &str) -> CustomPart {
        CustomPart {
            name: name.into(),
            kind,
            value: value.into(),
            color: None,
        }
    }

    fn wheel(name: &str, parts: Vec<CustomPart>) -> CustomWheel {
        CustomWheel {
            id: String::new(),
            name: name.into(),
            enabled: true,
            parts: Some(parts),
            actions: Vec::new(),
            extensions: Vec::new(),
        }
    }

    #[test]
    fn les_roues_d_avant_la_1_4_gardent_leurs_actions() {
        let settings: Settings = serde_json::from_str(
            r#"{ "customWheels": [{ "name": "Docs", "extensions": ["pdf"], "actions": [
                { "name": "Site", "kind": "url", "value": "https://exemple.fr" },
                { "name": "Tri", "kind": "command", "value": "sort \"$1\"" }
            ] }] }"#,
        )
        .unwrap();
        let settings = settings.sanitized();
        let docs = &settings.custom_wheels[0];
        assert_eq!(docs.id, "r1");
        assert!(docs.enabled);
        assert_eq!(docs.parts().len(), 2);
        assert_eq!(docs.parts()[1].kind, PartKind::Command);
        assert_eq!(docs.extensions, ["pdf"]);
        assert_eq!(
            settings.wheel_order,
            ["image", "video", "apps", "share", "actions", "custom:r1"],
            "une roue que l'ordre ne connaît pas se range à la fin"
        );
    }

    #[test]
    fn une_roue_melange_apps_sites_conversions_et_actions() {
        let settings = Settings {
            custom_wheels: vec![wheel(
                "Boulot",
                vec![
                    part(PartKind::App, "Mail", "/Applications/Mail.app"),
                    part(PartKind::Folder, "Projets", "/Users/moi/Projets"),
                    part(PartKind::Url, "YouTube", "https://youtube.com/"),
                    part(PartKind::Convert, "", "png"),
                    part(PartKind::Action, "", "image-fullHd"),
                    part(PartKind::Shortcut, "Ranger", "Ranger le bureau"),
                    // Écartées : format inconnu, identifiant piégé, app sans chemin
                    part(PartKind::Convert, "", "exe"),
                    part(PartKind::Action, "", "<script>"),
                    part(PartKind::App, "Rien", "  "),
                ],
            )],
            ..Settings::default()
        }
        .sanitized();
        let boulot = &settings.custom_wheels[0];
        let kinds: Vec<PartKind> = boulot.parts().iter().map(|part| part.kind).collect();
        assert_eq!(
            kinds,
            [
                PartKind::App,
                PartKind::Folder,
                PartKind::Url,
                PartKind::Convert,
                PartKind::Action,
                PartKind::Shortcut
            ]
        );
        // Les anciennes versions n'y lisent que ce qu'elles connaissent
        let legacy: Vec<&str> = boulot
            .actions
            .iter()
            .map(|part| part.name.as_str())
            .collect();
        assert_eq!(legacy, ["YouTube", "Ranger"]);
    }

    #[test]
    fn les_reglages_restent_lisibles_par_la_1_3() {
        let settings = Settings {
            wheel_order: vec!["custom:ab".into(), "share".into(), "image".into()],
            custom_wheels: vec![CustomWheel {
                id: "ab".into(),
                ..wheel(
                    "Mix",
                    vec![part(PartKind::App, "Mail", "/Applications/Mail.app")],
                )
            }],
            ..Settings::default()
        }
        .sanitized();
        let saved: serde_json::Value = serde_json::to_value(&settings).unwrap();
        // Les roues de Rutile seulement, dans l'ordre choisi
        let modes: Vec<&str> = saved["modes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect();
        assert_eq!(modes, ["share", "image", "video", "apps", "actions"]);
        // Et aucune part d'un genre que la 1.3 refuserait
        let kinds: Vec<&str> = saved["customWheels"][0]["actions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|action| action["kind"].as_str().unwrap())
            .collect();
        assert!(
            kinds
                .iter()
                .all(|kind| ["shortcut", "command", "url"].contains(kind))
        );
        assert_eq!(saved["customWheels"][0]["parts"][0]["kind"], "app");
    }

    #[test]
    fn retirer_la_derniere_part_ne_fait_pas_revenir_les_anciennes() {
        let mut emptied = wheel("Vide", Vec::new());
        emptied.actions = vec![part(PartKind::Url, "Reste", "https://exemple.fr")];
        let settings = Settings {
            custom_wheels: vec![emptied],
            ..Settings::default()
        }
        .sanitized();
        assert!(settings.custom_wheels[0].parts().is_empty());
        assert!(settings.custom_wheels[0].actions.is_empty());
    }

    #[test]
    fn les_roues_perso_prennent_leur_place_parmi_les_autres() {
        let settings = Settings {
            wheel_order: vec![
                "apps".into(),
                "custom:mix".into(),
                "image".into(),
                "custom:disparue".into(),
                "apps".into(),
            ],
            custom_wheels: vec![
                CustomWheel {
                    id: "mix".into(),
                    ..wheel("Mix", vec![part(PartKind::Convert, "", "png")])
                },
                // Sans part, elle n'a rien à afficher
                CustomWheel {
                    id: "vide".into(),
                    ..wheel("Vide", Vec::new())
                },
                CustomWheel {
                    id: "off".into(),
                    enabled: false,
                    ..wheel("Coupée", vec![part(PartKind::Convert, "", "mp4")])
                },
                // Même identifiant qu'une autre : elle en reçoit un nouveau
                CustomWheel {
                    id: "mix".into(),
                    ..wheel("Double", vec![part(PartKind::Convert, "", "gif")])
                },
            ],
            ..Settings::default()
        }
        .sanitized();
        assert_eq!(
            settings.wheel_order,
            [
                "apps",
                "custom:mix",
                "image",
                "video",
                "share",
                "actions",
                "custom:vide",
                "custom:off",
                "custom:r1"
            ]
        );
        assert_eq!(
            settings.enabled_modes(),
            [
                "apps",
                "custom:mix",
                "image",
                "video",
                "share",
                "actions",
                "custom:r1"
            ]
        );
    }

    #[test]
    fn une_roue_perso_peut_rester_la_seule_affichee() {
        let all_off = WheelMode::ALL
            .map(|id| ModeEntry { id, enabled: false })
            .to_vec();
        let alone = Settings {
            modes: all_off.clone(),
            custom_wheels: vec![wheel("Seule", vec![part(PartKind::Convert, "", "png")])],
            ..Settings::default()
        }
        .sanitized();
        assert_eq!(alone.enabled_modes(), ["custom:r1"]);

        // Limitée à certains fichiers, elle ne suffit pas : il faut une roue toujours là
        let mut limited = wheel("PDF", vec![part(PartKind::Convert, "", "png")]);
        limited.extensions = vec!["pdf".into()];
        let settings = Settings {
            modes: all_off,
            custom_wheels: vec![limited],
            ..Settings::default()
        }
        .sanitized();
        assert_eq!(settings.enabled_modes(), ["image", "custom:r1"]);
    }

    #[test]
    fn un_reglage_illisible_n_emporte_pas_les_autres() {
        let settings = parse(
            r#"{ "jpegQuality": 75, "modes": [{ "id": "hologramme", "enabled": true }],
                 "apps": "pas une liste", "shortcut": "Alt+Space",
                 "customWheels": [{ "name": "Demain", "parts": [
                     { "name": "Vu", "kind": "url", "value": "https://exemple.fr" },
                     { "name": "Pas encore", "kind": "telepathie", "value": "x" }
                 ] }] }"#,
        )
        .unwrap()
        .sanitized();
        assert_eq!(settings.jpeg_quality, 75);
        assert_eq!(settings.shortcut, "Alt+Space");
        assert_eq!(settings.modes.len(), WheelMode::ALL.len());
        assert_eq!(settings.apps.len(), MIN_SLOTS);
        assert_eq!(settings.custom_wheels[0].parts().len(), 1);
        assert!(parse("pas du JSON").is_none());
    }

    #[test]
    fn un_fichier_incomplet_garde_les_valeurs_par_defaut() {
        let settings: Settings = serde_json::from_str(r#"{ "jpegQuality": 75 }"#).unwrap();
        assert_eq!(settings.jpeg_quality, 75);
        assert_eq!(settings.webp_quality, Settings::default().webp_quality);
        assert_eq!(settings.shortcut, shortcut::DEFAULT_SHORTCUT);
    }

    #[test]
    fn la_roue_actions_arrive_active_chez_ceux_qui_ne_l_ont_pas_encore() {
        let settings: Settings =
            serde_json::from_str(r#"{ "modes": [{ "id": "image", "enabled": true }] }"#).unwrap();
        assert!(
            settings
                .sanitized()
                .enabled_modes()
                .contains(&"actions".to_owned())
        );
    }

    #[test]
    fn une_part_ou_une_action_ne_peut_ouvrir_qu_une_adresse_web() {
        let url = |path: &str| AppSlot {
            path: path.into(),
            name: "Site".into(),
            kind: apps::AppKind::Url,
        };
        let settings = Settings {
            apps: vec![
                Some(url("https://exemple.fr")),
                Some(url("file:///etc/passwd")),
            ],
            custom_wheels: vec![wheel(
                "Test",
                vec![
                    part(PartKind::Url, "Bon", "https://exemple.fr"),
                    part(PartKind::Url, "Piégé", "javascript:alert(1)"),
                ],
            )],
            ..Settings::default()
        }
        .sanitized();
        assert!(settings.apps[0].is_some());
        assert!(settings.apps[1].is_none());
        assert_eq!(settings.custom_wheels[0].parts().len(), 1);
    }

    #[test]
    fn une_ancienne_part_reste_une_app() {
        let slot: AppSlot =
            serde_json::from_str(r#"{ "path": "/Applications/Mail.app", "name": "Mail" }"#)
                .unwrap();
        assert_eq!(slot.kind, apps::AppKind::App);
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
                WheelMode::Share,
                WheelMode::Actions
            ]
        );
        assert_eq!(settings.enabled_modes(), ["video", "share", "actions"]);
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
        assert_eq!(none_enabled.enabled_modes(), ["image"]);
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
    fn images_et_videos_vont_d_abord_au_convertisseur() {
        let settings: Settings = serde_json::from_str(r#"{ "jpegQuality": 75 }"#).unwrap();
        let files = settings.file_wheels;
        assert_eq!(files.images.first, FirstWheel::Convert);
        assert_eq!(files.videos.first, FirstWheel::Convert);
        assert_eq!(files.pdfs.first, FirstWheel::Actions);
        assert_eq!(files.others.first, FirstWheel::Actions);
    }

    #[test]
    fn les_listes_d_actions_sont_nettoyees() {
        let entry = |id: &str| PartEntry {
            id: id.into(),
            enabled: true,
        };
        let mut settings: Settings = serde_json::from_str(
            r#"{ "fileWheels": { "pdfs": { "first": "convert" }, "others": { "first": "plus-tard" } } }"#,
        )
        .unwrap();
        assert_eq!(settings.file_wheels.images.first, FirstWheel::Convert);
        settings.action_parts = vec![
            entry("action-text"),
            entry("action-text"),
            entry("<script>"),
        ];
        settings.file_wheels.images.parts = vec![entry("image-fullHd")];
        settings.custom_wheels = vec![CustomWheel {
            name: " Docs ".into(),
            extensions: vec![".PDF".into(), "pdf".into(), "docx".into(), "a b".into()],
            ..wheel("", Vec::new())
        }];
        let settings = settings.sanitized();
        assert_eq!(settings.action_parts, [entry("action-text")]);
        assert_eq!(
            settings.file_wheels.images.parts,
            [entry("image-fullHd")],
            "une majuscule dans un identifiant ne le fait pas rejeter"
        );
        assert_eq!(settings.file_wheels.pdfs.first, FirstWheel::Actions);
        assert_eq!(settings.file_wheels.others.first, FirstWheel::Usual);
        assert_eq!(settings.custom_wheels[0].extensions, ["pdf", "docx"]);
    }

    #[test]
    fn un_contour_inconnu_redevient_le_contour_par_defaut() {
        let read = |json: &str| serde_json::from_str::<Settings>(json).unwrap();
        let settings = read(r#"{ "wheelBorder": "dark", "jpegQuality": 75 }"#);
        assert_eq!(settings.wheel_border, WheelBorder::Dark);
        let settings = read(r#"{ "wheelBorder": "light" }"#);
        assert_eq!(settings.wheel_border, WheelBorder::Light, "le choix d'avant la 1.5 reste");
        let settings = read(r#"{ "wheelBorder": "arc-en-ciel", "jpegQuality": 75 }"#);
        assert_eq!(settings.wheel_border, WheelBorder::None);
        assert_eq!(settings.jpeg_quality, 75);
        assert_eq!(Settings::default().wheel_border, WheelBorder::None);
        assert_eq!(
            serde_json::to_value(WheelBorder::Color).unwrap(),
            serde_json::json!("color")
        );
    }

    #[test]
    fn les_couleurs_du_contour_et_des_parts_sont_verifiees() {
        let settings: Settings = serde_json::from_str(
            r##"{ "wheelBorder": "color", "wheelBorderColor": "#E5484D",
                 "customWheels": [{ "name": "Docs", "parts": [
                   { "name": "PNG", "kind": "convert", "value": "png", "color": "#16A34A" },
                   { "name": "WebP", "kind": "convert", "value": "webp", "color": "vert" },
                   { "name": "AVIF", "kind": "convert", "value": "avif" }
                 ] }] }"##,
        )
        .unwrap();
        let settings = settings.sanitized();
        assert_eq!(settings.wheel_border, WheelBorder::Color);
        assert_eq!(settings.wheel_border_color.as_deref(), Some("#e5484d"));
        let colors: Vec<_> = settings.custom_wheels[0]
            .parts()
            .iter()
            .map(|part| part.color.as_deref())
            .collect();
        assert_eq!(colors, [Some("#16a34a"), None, None]);
        // Une part sans couleur n'écrit rien : les versions d'avant la 1.5 relisent la même part
        let saved = serde_json::to_value(&settings.custom_wheels[0].parts()[2]).unwrap();
        assert!(saved.get("color").is_none());
    }
}
