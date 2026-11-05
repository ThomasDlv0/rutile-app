import { invoke } from "@tauri-apps/api/core";
import type { Mode, OutputFormat, VideoFormat } from "./wheel/formats";

// Noms partagés avec src-tauri/src/app/wheel.rs
export const WHEEL_OPEN_EVENT = "wheel://open";
/** Le raccourci pressé alors que la roue est ouverte la referme. */
export const WHEEL_CLOSE_EVENT = "wheel://close";
/** Fichiers sélectionnés dans le Finder ou l'Explorateur, lus après l'ouverture. */
export const WHEEL_FILES_EVENT = "wheel://files";
export const WHEEL_DRAG_EVENT = "wheel://drag";
/** Avancement d'une conversion vidéo, de 0 à 1. */
export const WHEEL_PROGRESS_EVENT = "wheel://progress";

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
/** `null` quand le système ne permet pas de le savoir. */
export const primaryButtonPressed = () => invoke<boolean | null>("primary_button_pressed");
export const inspectFiles = (paths: string[]) => invoke<FileInfo[]>("inspect_files", { paths });
/** Sélecteur de fichiers du système, filtré selon la roue ; liste vide si l'utilisateur annule. */
export const pickFiles = (kind: "images" | "videos" | "any") =>
  invoke<FileInfo[]>("pick_files", { kind });
/** Se termine quand la conversion est finie ; Rust envoie la notification. */
export const convertFiles = (paths: string[], format: OutputFormat) =>
  invoke<Outcome>("convert_files", { paths, format });
/** Conversion par FFmpeg ; l'avancement arrive par `wheel://progress`. */
export const convertVideos = (paths: string[], format: VideoFormat) =>
  invoke<Outcome>("convert_videos", { paths, format });

export interface VideoSupport {
  available: boolean;
  /** Commande d'installation de FFmpeg pour ce système. */
  installHint: string;
}

export const videoSupport = () => invoke<VideoSupport>("video_support");

export interface Settings {
  shortcut: string;
  shakeEnabled: boolean;
  shakeSensitivity: number;
  jpegQuality: number;
  webpQuality: number;
  avifQuality: number;
  /** Ordre du clic au centre, et roues affichées ou non. */
  modes: { id: Mode; enabled: boolean }[];
  /** La roue se rouvre sur celle affichée à la fermeture, plutôt que sur la première. */
  rememberWheel: boolean;
  /** Millisecondes au centre, un fichier glissé, avant de basculer entre conversion et partage. */
  dwellMs: number;
  /** Couleur choisie par format (« png » → « #3b82f6 ») ; un format absent garde la sienne. */
  formatColors: Record<string, string>;
  /** Couleur de la part survolée ; `null` pour le bleu d'origine. */
  highlightColor: string | null;
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
  platform: "macos" | "windows" | "linux" | string;
  version: string;
  /** Apps des parts, avec leurs icônes. */
  apps: (AppView | null)[];
  /** Destinations de la roue de partage, avec leurs icônes. */
  share: (ShareView | null)[];
  /** Onglet demandé à l'ouverture (une part vide de la roue, par exemple). */
  tab: SettingsTab | null;
}

export type SettingsTab = "general" | "wheels" | "conversion" | "colors" | "apps" | "share";

/** Onglet demandé alors que la fenêtre de réglages est déjà ouverte. */
export const SETTINGS_TAB_EVENT = "settings://tab";

export const getSettings = () => invoke<SettingsView>("get_settings");
/** Applique et enregistre ; rejette avec un message en français si une valeur est refusée. */
export const updateSettings = (settings: Settings) =>
  invoke<SettingsView>("update_settings", { settings });
export const setLaunchAtLogin = (enabled: boolean) =>
  invoke<boolean>("set_launch_at_login", { enabled });
export const openPermissionSettings = () => invoke("open_permission_settings");

/** App d'une part de la roue des apps. */
export interface AppView {
  path: string;
  name: string;
  /** PNG en data URL, absent quand le système ne fournit pas d'icône. */
  icon: string | null;
}

export interface AppSlot {
  path: string;
  name: string;
}

/** Roues actives dans l'ordre du clic au centre, apps et destinations de partage des parts. */
export interface WheelConfig {
  modes: Mode[];
  /** Rouvrir sur la dernière roue affichée. */
  remember: boolean;
  /** Temps au centre avant de basculer entre conversion et partage. */
  dwellMs: number;
  /** Couleurs choisies pour les formats, et pour la part survolée. */
  colors: Record<string, string>;
  highlight: string | null;
  apps: (AppView | null)[];
  share: (ShareView | null)[];
}

/** Réglages des roues modifiés : la roue relit sa configuration. */
export const WHEEL_CONFIG_EVENT = "wheel://config";

export const wheelConfig = () => invoke<WheelConfig>("wheel_config");
/** Sélecteur d'application ; `null` si l'utilisateur annule. */
export const pickApp = () => invoke<AppSlot | null>("pick_app");
/** Pastilles de notifications des apps de la roue (macOS), dans l'ordre des parts. */
export const appBadges = () => invoke<(string | null)[]>("app_badges");
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
