import { invoke } from "@tauri-apps/api/core";
import type { OutputFormat } from "./wheel/formats";

// Noms partagés avec src-tauri/src/app/wheel.rs
export const WHEEL_OPEN_EVENT = "wheel://open";
/** Le raccourci pressé alors que la roue est ouverte la referme. */
export const WHEEL_CLOSE_EVENT = "wheel://close";
/** Fichiers sélectionnés dans le Finder ou l'Explorateur, lus après l'ouverture. */
export const WHEEL_FILES_EVENT = "wheel://files";
export const WHEEL_DRAG_EVENT = "wheel://drag";

export interface WheelOpened {
  id: number;
  /** `focus` : raccourci ou menu ; `drop` : secouage, sans focus, en attente du fichier glissé. */
  mode: "focus" | "drop";
  /** Des fichiers vont suivre (`wheel://files` avec le même `id`). */
  loadingFiles: boolean;
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

export interface FileInfo {
  path: string;
  name: string;
  /** `null` si ce n'est pas une image prise en charge. */
  format: InputFormat | null;
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
/** Sélecteur de fichiers du système ; liste vide si l'utilisateur annule. */
export const pickFiles = () => invoke<FileInfo[]>("pick_files");
/** Se termine quand la conversion est finie ; Rust envoie la notification. */
export const convertFiles = (paths: string[], format: OutputFormat) =>
  invoke<Outcome>("convert_files", { paths, format });

export interface Settings {
  shortcut: string;
  shakeEnabled: boolean;
  shakeSensitivity: number;
  jpegQuality: number;
  webpQuality: number;
  avifQuality: number;
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
}

export const getSettings = () => invoke<SettingsView>("get_settings");
/** Applique et enregistre ; rejette avec un message en français si une valeur est refusée. */
export const updateSettings = (settings: Settings) =>
  invoke<SettingsView>("update_settings", { settings });
export const setLaunchAtLogin = (enabled: boolean) =>
  invoke<boolean>("set_launch_at_login", { enabled });
export const openPermissionSettings = () => invoke("open_permission_settings");
