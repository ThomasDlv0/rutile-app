import { invoke } from "@tauri-apps/api/core";
import type { BuiltinMode, Mode, OutputFormat, VideoFormat } from "./wheel/formats";

// Noms partagés avec src-tauri/src/app/wheel.rs
export const WHEEL_OPEN_EVENT = "wheel://open";
/** Le raccourci pressé alors que la roue est ouverte la referme. */
export const WHEEL_CLOSE_EVENT = "wheel://close";
/** Fichiers sélectionnés dans le Finder ou l'Explorateur, lus après l'ouverture. */
export const WHEEL_FILES_EVENT = "wheel://files";
export const WHEEL_DRAG_EVENT = "wheel://drag";
/** Avancement d'une conversion vidéo, de 0 à 1. */
export const WHEEL_PROGRESS_EVENT = "wheel://progress";
/** Résultat d'une action, affiché à côté du curseur. */
export const WHEEL_TOAST_EVENT = "wheel://toast";

export interface Toast {
  title: string;
  body: string;
  ok: boolean;
}

export interface WheelOpened {
  id: number;
  /** `focus` : raccourci ou menu ; `drop` : secouage, sans focus, en attente du fichier glissé. */
  mode: "focus" | "drop";
}

export interface WheelFiles {
  id: number;
  files: FileInfo[];
}

/** Glisser-déposer au-dessus de la roue ; Rust donne la position en pixels CSS. */
export type WheelDrag =
  | { type: "enter"; paths: string[]; x: number; y: number }
  | { type: "over"; x: number; y: number }
  | { type: "drop"; paths: string[]; x: number; y: number }
  | { type: "leave" };

/** Format réel d'un fichier, lu dans son contenu par Rust. */
export type InputFormat = OutputFormat | "gif" | "bmp" | "tiff";

/** Conteneur d'une vidéo ; `other` est lisible par FFmpeg sans équivalent sur la roue. */
export type VideoInput = "mp4" | "mov" | "webm" | "mkv" | "avi" | "other";

export interface FileInfo {
  path: string;
  name: string;
  /** `null` si ce n'est pas une image prise en charge. */
  format: InputFormat | null;
  /** `null` si ce n'est pas une vidéo reconnue. */
  video: VideoInput | null;
}

export interface Outcome {
  converted: number;
  failed: number;
}

export const wheelReady = () => invoke("wheel_ready");
export const hideWheel = () => invoke("hide_wheel");
/** Montre la fenêtre pour une annonce, sans prendre le clavier ni la souris. */
export const showToastWindow = () => invoke("show_toast");
export const hideToastWindow = () => invoke("hide_toast");
/** La roue joue son animation de fermeture : le verre natif la suit. */
export const wheelClosing = () => invoke("wheel_closing");
/** `null` quand le système ne permet pas de le savoir. */
export const primaryButtonPressed = () => invoke<boolean | null>("primary_button_pressed");
export const inspectFiles = (paths: string[]) => invoke<FileInfo[]>("inspect_files", { paths });
/** Sélecteur de fichiers du système, filtré selon la roue ; liste vide si l'utilisateur annule. */
export const pickFiles = (kind: "images" | "videos" | "pdfs" | "archives" | "files" | "any") =>
  invoke<FileInfo[]>("pick_files", { kind });
/** Se termine quand la conversion est finie ; Rust envoie la notification. */
export const convertFiles = (paths: string[], format: OutputFormat) =>
  invoke<Outcome>("convert_files", { paths, format });
/** Conversion par FFmpeg ; l'avancement arrive par `wheel://progress`. */
export const convertVideos = (paths: string[], format: VideoFormat) =>
  invoke<Outcome>("convert_videos", { paths, format });

/** Ce qu'une part de la roue Actions demande de faire. */
export type ActionRequest =
  | { kind: "capture"; target: "zone" | "window" | "screen"; delay: number }
  | { kind: "text" }
  | { kind: "color"; format: "hex" | "rgb" | "hsl" }
  | { kind: "zip" }
  | { kind: "extract" }
  | { kind: "imagesToPdf" }
  | { kind: "mergePdfs" }
  | { kind: "pdfText" }
  | { kind: "readText" }
  | { kind: "copyImage" }
  | { kind: "copyPaths" }
  | { kind: "rename"; style: "number" | "date" | "lowercase" | "clean" }
  | { kind: "retouch"; retouch: "half" | "fullHd" | "compress" | "stripMetadata" }
  | {
      kind: "video";
      rework: { kind: "compress" } | { kind: "fit"; megabytes: number } | { kind: "mute" };
    }
  | {
      kind: "place";
      layout: "left" | "right" | "top" | "bottom" | "maximize" | "center";
    }
  | { kind: "custom"; wheel: number; action: number };

/** Se termine quand l'action est finie ; Rust envoie la notification. */
export const runAction = (request: ActionRequest, paths: string[]) =>
  invoke("run_action", { request, paths });

export interface VideoSupport {
  available: boolean;
  /** Commande d'installation de FFmpeg pour ce système. */
  installHint: string;
}

export const videoSupport = () => invoke<VideoSupport>("video_support");

/** Contour du disque de la roue : aucun (par défaut), le trait clair, noir, ou une couleur. */
export type WheelBorder = "none" | "light" | "dark" | "color";

export interface Settings {
  shortcut: string;
  shakeEnabled: boolean;
  shakeSensitivity: number;
  jpegQuality: number;
  webpQuality: number;
  avifQuality: number;
  /** Roues de Rutile, affichées ou non. Leur ordre suit `wheelOrder`. */
  modes: { id: BuiltinMode; enabled: boolean }[];
  /** Ordre du clic au centre, roues personnalisées comprises. */
  wheelOrder: Mode[];
  /** La roue se rouvre sur celle affichée à la fermeture, plutôt que sur la première. */
  rememberWheel: boolean;
  /** Millisecondes au centre, un fichier glissé, avant de basculer entre conversion et partage. */
  dwellMs: number;
  /** Couleur choisie par format (« png » → « #3b82f6 ») ; un format absent garde la sienne. */
  formatColors: Record<string, string>;
  /** Couleur de la part survolée ; `null` pour le bleu d'origine. */
  highlightColor: string | null;
  wheelBorder: WheelBorder;
  /** Couleur du contour « color » ; `null` pour celle de la surbrillance. */
  wheelBorderColor: string | null;
  /** Liquid Glass sur le disque de la roue. */
  wheelGlass: boolean;
  /** Une capture rouvre la roue sur l'image, pour la convertir ou la partager. */
  captureReopen: boolean;
  /** Roues faites par l'utilisateur : elles prennent leur place parmi les autres. */
  customWheels: CustomWheel[];
  /** Ordre des parts de la roue Actions, et parts affichées ou non. */
  actionParts: PartEntry[];
  /** Roue ouverte d'abord et actions proposées, selon le type des fichiers. */
  fileWheels: FileWheels;
  /** Une app (ou rien) par part, dans le sens horaire depuis le haut. */
  apps: (AppSlot | null)[];
  /** Une destination (ou rien) par part de la roue de partage. */
  share: (ShareTarget | null)[];
  /** Chercher les nouvelles versions au lancement puis régulièrement, et les proposer. */
  autoUpdate: boolean;
}

/** Version installée, et version publiée plus récente s'il y en a une. */
export interface UpdateStatus {
  current: string;
  available: string | null;
  notes: string | null;
}

/** Avancement du téléchargement d'une mise à jour, de 0 à 1. */
export const UPDATE_PROGRESS_EVENT = "updates://progress";

export interface SettingsView {
  settings: Settings;
  /** Raccourci tel qu'on l'écrit sur ce système (« ⌘⇧Espace »). */
  shortcutLabel: string;
  defaultShortcut: string;
  shortcutsSupported: boolean;
  wayland: boolean;
  launchAtLogin: boolean;
  /** macOS seulement : autorisation de lire la sélection du Finder. */
  finderPermission: "granted" | "denied" | "notAsked" | "unknown" | null;
  /** macOS seulement : autorisation Accessibilité, pour les pastilles et les fenêtres. */
  dockAccess: boolean | null;
  /** Le vrai Liquid Glass existe sur ce système (macOS 26 ou plus récent). */
  nativeGlass: boolean;
  platform: "macos" | "windows" | "linux" | string;
  version: string;
  /** Apps des parts, avec leurs icônes. */
  apps: (AppView | null)[];
  /** Destinations de la roue de partage, avec leurs icônes. */
  share: (ShareView | null)[];
  /** Roues personnalisées, avec les icônes de leurs parts. */
  custom: CustomWheelView[];
  /** Onglet demandé à l'ouverture (une part vide de la roue, par exemple). */
  tab: SettingsTab | null;
}

export type SettingsTab =
  | "general"
  | "wheels"
  | "custom"
  | "apps"
  | "share"
  | "actions"
  | "conversion"
  | "colors";

/** Onglet demandé alors que la fenêtre de réglages est déjà ouverte. */
export const SETTINGS_TAB_EVENT = "settings://tab";
/** Un logo de site vient d'arriver : les réglages relisent leurs icônes. */
export const SETTINGS_REFRESH_EVENT = "settings://refresh";

export const getSettings = () => invoke<SettingsView>("get_settings");
/** Applique et enregistre ; rejette avec un message en français si une valeur est refusée. */
export const updateSettings = (settings: Settings) =>
  invoke<SettingsView>("update_settings", { settings });
export const setLaunchAtLogin = (enabled: boolean) =>
  invoke<boolean>("set_launch_at_login", { enabled });
/** Volet des Réglages Système (macOS) où se donne l'autorisation : lire le Finder, ou le Dock. */
export const openPermissionSettings = (pane: "automation" | "accessibility" | "screen") =>
  invoke("open_permission_settings", { pane });

/** Ce qu'une part de la roue des apps ouvre : `path` est alors une app, un dossier ou une
 * adresse. */
export type AppKind = "app" | "folder" | "url";

/** App d'une part de la roue des apps. */
export interface AppView {
  path: string;
  name: string;
  kind: AppKind;
  /** PNG en data URL, absent quand le système ne fournit pas d'icône. */
  icon: string | null;
}

export interface AppSlot {
  path: string;
  name: string;
  kind: AppKind;
}

/** Ce que fait une part d'une roue personnalisée. `value` est alors le chemin de l'app ou du
 * dossier, l'adresse du site, le format de la conversion, l'identifiant de l'action, le nom du
 * Raccourci (macOS) ou la commande. */
export type PartKind = "app" | "folder" | "url" | "convert" | "action" | "shortcut" | "command";

export interface CustomPart {
  /** Nom affiché ; celui d'une conversion ou d'une action vient de la roue. */
  name: string;
  kind: PartKind;
  value: string;
  /** Couleur choisie pour la part ; absente, celle de son format ou de son action. */
  color?: string | null;
}

export interface CustomWheel {
  /** Identifiant stable, attribué par Rust quand il est vide. */
  id: string;
  name: string;
  /** Affichée parmi les roues, au clic sur le centre. */
  enabled: boolean;
  parts: CustomPart[];
  /** Extensions des fichiers pour lesquels la roue apparaît (`pdf`, `docx`) ; vide, toujours. */
  extensions: string[];
}

/** Roue personnalisée telle qu'on l'affiche : ni commande, ni adresse. */
export interface CustomWheelView {
  id: string;
  name: string;
  parts: CustomPartView[];
  extensions: string[];
}

export interface CustomPartView {
  name: string;
  kind: PartKind;
  /** Format d'une conversion ou identifiant d'une action, `null` pour les autres parts. */
  value: string | null;
  /** Icône d'une app, d'un dossier ou d'un site, en data URL. */
  icon: string | null;
  /** Couleur choisie pour la part. */
  color?: string | null;
}

/** Part d'une liste réglable de la roue Actions, à sa place, affichée ou non. */
export interface PartEntry {
  id: string;
  enabled: boolean;
}

/** Types de fichiers qui ont chacun leur roue Actions ; `others` couvre aussi les mélanges. */
export type FileKind = "images" | "videos" | "pdfs" | "archives" | "others";

/** Roue ouverte d'abord quand arrive un fichier ; `usual`, la première de la liste. */
export type FirstWheel = "convert" | "actions" | "share" | "apps" | "usual";

export interface FileWheel {
  first: FirstWheel;
  parts: PartEntry[];
}

export type FileWheels = Record<FileKind, FileWheel>;

/** Roues actives dans l'ordre du clic au centre, apps et destinations de partage des parts. */
export interface WheelConfig {
  /** Roues de Rutile et roues personnalisées (`custom:` puis leur identifiant). */
  modes: Mode[];
  /** Rouvrir sur la dernière roue affichée. */
  remember: boolean;
  /** Temps au centre avant de basculer entre conversion et partage. */
  dwellMs: number;
  /** Couleurs choisies pour les formats, et pour la part survolée. */
  colors: Record<string, string>;
  highlight: string | null;
  border: WheelBorder;
  /** Couleur du contour « color ». */
  borderColor: string | null;
  /** Matière du disque : le vrai Liquid Glass, son imitation, ou le disque sombre d'origine. */
  glass: "native" | "css" | "off";
  /** Les fenêtres se rangent sur ce système (pas sous Wayland). */
  windowLayout: boolean;
  custom: CustomWheelView[];
  actionParts: PartEntry[];
  fileWheels: FileWheels;
  apps: (AppView | null)[];
  share: (ShareView | null)[];
}

/** Réglages des roues modifiés : la roue relit sa configuration. */
export const WHEEL_CONFIG_EVENT = "wheel://config";

export const wheelConfig = () => invoke<WheelConfig>("wheel_config");
/** Sélecteur d'application ; `null` si l'utilisateur annule. */
export const pickApp = () => invoke<AppSlot | null>("pick_app");
/** Sélecteur de dossier pour une part de la roue des apps. */
export const pickAppFolder = () => invoke<AppSlot | null>("pick_app_folder");

/** Nom et logo d'un site, lus sur le site lui-même. */
export interface SitePreview {
  name: string;
  /** PNG en data URL ; `null` si le site n'a pas donné de logo. */
  icon: string | null;
}

/** Demande au site son nom et son logo ; rejette si l'adresse n'est pas une adresse web. */
export const sitePreview = (address: string) => invoke<SitePreview>("site_preview", { address });
/** Pastilles de notifications des apps de la roue (macOS), dans l'ordre des parts. */
export const appBadges = () => invoke<(string | null)[]>("app_badges");
/** macOS : Rutile peut-il lire les pastilles du Dock, celles des apps fermées comprises ? */
export const dockBadgesAllowed = () => invoke<boolean | null>("dock_badges_allowed");
/** Demande l'autorisation Accessibilité ; vrai si elle est déjà accordée. */
export const allowDockBadges = () => invoke<boolean>("allow_dock_badges");
/** Lance l'app de la part `slot`, en lui faisant ouvrir les fichiers s'il y en a. */
export const launchApp = (slot: number, paths: string[]) =>
  invoke("launch_app", { slot, paths });
/** Ouvre les réglages, sur l'onglet `tab` s'il est donné. */
export const openSettings = (tab?: SettingsTab) => invoke("open_settings", { tab });

/** Destination d'une part de la roue de partage. */
export type ShareTarget =
  /** Service du système (macOS) : AirDrop, Messages, Mail… */
  | { kind: "service"; id: string; name: string }
  /** Dossier où copier les fichiers : Google Drive, iCloud Drive… */
  | { kind: "folder"; path: string; name: string }
  /** Messagerie sans extension de partage : fichiers copiés, puis app ouverte. */
  | { kind: "app"; path: string; name: string }
  /** Menu de partage du système (macOS) : on y choisit l'app, puis le destinataire. */
  | { kind: "system"; name: string };

export type ShareView = ShareTarget & {
  /** PNG en data URL. */
  icon: string | null;
};

/** Destination proposée dans les réglages, rangée par famille. */
export type ShareChoice = ShareView & { group: string };

export const shareChoices = () => invoke<ShareChoice[]>("share_choices");
/** Cherche la dernière version publiée. */
export const checkUpdate = () => invoke<UpdateStatus>("check_update");
/** Télécharge et installe la dernière version, puis relance Rutile. */
export const installUpdate = () => invoke("install_update");
/** Sélecteur de dossier ; `null` si l'utilisateur annule. */
export const pickShareFolder = () => invoke<ShareView | null>("pick_share_folder");
/** Partage les fichiers avec la destination de la part `slot`. */
export const shareFiles = (slot: number, paths: string[]) =>
  invoke("share_files", { slot, paths });
