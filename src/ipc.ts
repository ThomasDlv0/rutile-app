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
/** Sélecteur de fichiers du système, filtré selon le mode ; liste vide si l'utilisateur annule. */
export const pickFiles = (videos: boolean) => invoke<FileInfo[]>("pick_files", { videos });
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
  /** Une app (ou rien) par part, dans le sens horaire depuis le haut. */
  apps: (AppSlot | null)[];
}

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
}

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

/** Roues actives dans l'ordre du clic au centre, et apps des parts. */
export interface WheelConfig {
  modes: Mode[];
  apps: (AppView | null)[];
}

/** Réglages des roues modifiés : la roue relit sa configuration. */
export const WHEEL_CONFIG_EVENT = "wheel://config";

export const wheelConfig = () => invoke<WheelConfig>("wheel_config");
/** Sélecteur d'application ; `null` si l'utilisateur annule. */
export const pickApp = () => invoke<AppSlot | null>("pick_app");
/** Lance l'app de la part `slot`, en lui faisant ouvrir les fichiers s'il y en a. */
export const launchApp = (slot: number, paths: string[]) =>
  invoke("launch_app", { slot, paths });
export const openSettings = () => invoke("open_settings");
