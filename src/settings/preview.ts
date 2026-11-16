/** Réglages factices pour l'aperçu dans un navigateur, sans Tauri. */

import type { SettingsView, ShareChoice, ShareView } from "../ipc";
import { DEFAULT_FILE_WHEELS } from "../wheel/actions";
import { targetOf } from "./shared";

// Aperçu dans un navigateur, sans Tauri
const PREVIEW_SHARE: (ShareView | null)[] = [
  { kind: "service", id: "com.apple.share.AirDrop.send", name: "AirDrop", icon: null },
  { kind: "service", id: "com.apple.share.Messages.window", name: "Messages", icon: null },
  { kind: "app", path: "/Applications/Signal.app", name: "Signal", icon: null },
  { kind: "folder", path: "/iCloud", name: "iCloud Drive", icon: null },
  { kind: "service", id: "com.apple.share.Mail.compose", name: "Mail", icon: null },
  null,
];

export const PREVIEW_CHOICES: ShareChoice[] = [
  ...PREVIEW_SHARE.filter((view) => view !== null).map((view) => ({
    ...view,
    group:
      view.kind === "service"
        ? "Partage du système"
        : view.kind === "folder"
          ? "Dossiers synchronisés"
          : "Messageries",
  })),
  { kind: "system", name: "Partager…", icon: null, group: "Partage du système" },
  { kind: "service", id: "notes", name: "Notes", icon: null, group: "Partage du système" },
];

export const PREVIEW: SettingsView = {
  settings: {
    shortcut: "CommandOrControl+Shift+Space",
    shakeEnabled: true,
    shakeSensitivity: 5,
    jpegQuality: 90,
    webpQuality: 85,
    avifQuality: 70,
    modes: [
      { id: "image", enabled: true },
      { id: "video", enabled: true },
      { id: "apps", enabled: true },
      { id: "share", enabled: true },
      { id: "actions", enabled: true },
    ],
    wheelOrder: [],
    rememberWheel: false,
    dwellMs: 1000,
    formatColors: {},
    highlightColor: null,
    wheelBorder: "none",
    wheelBorderColor: null,
    wheelGlass: true,
    captureReopen: true,
    customWheels: [
      {
        id: "r1",
        name: "Boulot",
        enabled: true,
        parts: [
          { name: "PNG", kind: "convert", value: "png" },
          { name: "WebP", kind: "convert", value: "webp", color: "#ec4899" },
          { name: "Capture", kind: "action", value: "action-capture" },
          { name: "YouTube", kind: "url", value: "https://youtube.com/" },
        ],
        extensions: [],
      },
    ],
    actionParts: [],
    fileWheels: DEFAULT_FILE_WHEELS,
    apps: [
      { path: "/Applications/Finder.app", name: "Finder", kind: "app" },
      { path: "https://youtube.com/", name: "YouTube", kind: "url" },
      null,
      null,
      null,
      null,
    ],
    share: PREVIEW_SHARE.map((view) => view && targetOf(view)),
    autoUpdate: true,
    language: null,
  },
  shortcutLabel: "⌘⇧Espace",
  defaultShortcut: "CommandOrControl+Shift+Space",
  shortcutsSupported: true,
  wayland: false,
  launchAtLogin: false,
  finderPermission: "granted",
  dockAccess: false,
  nativeGlass: true,
  platform: "macos",
  version: "1.5.3",
  apps: [
    { path: "/Applications/Finder.app", name: "Finder", kind: "app", icon: null },
    { path: "https://youtube.com/", name: "YouTube", kind: "url", icon: null },
    null,
    null,
    null,
    null,
  ],
  share: PREVIEW_SHARE,
  custom: [],
  tab: null,
  language: "fr",
  systemLanguage: "fr",
};
