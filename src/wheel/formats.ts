import type { AppView, ShareView } from "../ipc";
import { readableInk } from "./color";
import { MAX_SECTORS, SECTOR_COUNT } from "./geometry";

// Couleurs par défaut des formats, comme des icônes de fichiers ; elles se changent dans
// les réglages
const BLUE = "#3b82f6";
const ORANGE = "#f97316";
const GREEN = "#16a34a";
const VIOLET = "#8b5cf6";
const GRAY = "#6b7280";
const PINK = "#ec4899";

// Ordre des parts, dans le sens horaire en partant du haut
export const OUTPUT_FORMATS = [
  { id: "png", label: "PNG", color: BLUE },
  { id: "jpeg", label: "JPEG", color: ORANGE },
  { id: "webp", label: "WebP", color: GREEN },
  { id: "avif", label: "AVIF", color: VIOLET },
  { id: "svg", label: "SVG", color: "#f2b705" },
  { id: "ico", label: "ICO", color: GRAY },
] as const;

export const VIDEO_FORMATS = [
  { id: "mp4", label: "MP4", color: BLUE },
  { id: "webm", label: "WebM", color: GREEN },
  { id: "mov", label: "MOV", color: GRAY },
  { id: "mkv", label: "MKV", color: VIOLET },
  { id: "gif", label: "GIF", color: PINK },
  { id: "mp3", label: "MP3", color: ORANGE, action: "Extraire le son en MP3" },
] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number]["id"];
export type VideoFormat = (typeof VIDEO_FORMATS)[number]["id"];

/** Les roues entre lesquelles le clic au centre fait passer. */
export type Mode = "image" | "video" | "apps" | "share";

export const ALL_MODES: readonly Mode[] = ["image", "video", "apps", "share"];

/** Contenu d'une part de la roue : un format, ou une app. */
export interface WheelItem {
  id: string;
  label: string;
  /** Texte du centre au survol, « Convertir en … » par défaut. */
  action?: string;
  /** Icône d'app, en data URL. */
  icon?: string;
  /** Couleur du bouton d'un format, et de son texte, choisi pour rester lisible. */
  color?: string;
  ink?: string;
  /** Part de la roue des apps ou de partage laissée libre. */
  empty?: boolean;
  /** Pastille de notifications de l'app, comme dans le Dock. */
  badge?: string;
}

export function formatsFor(mode: "image" | "video"): readonly WheelItem[] {
  return mode === "image" ? OUTPUT_FORMATS : VIDEO_FORMATS;
}

/** Formats avec les couleurs choisies dans les réglages, et un texte lisible dessus. */
export function colorize(
  items: readonly WheelItem[],
  colors: Readonly<Record<string, string>>,
): WheelItem[] {
  return items.map((item) => {
    const color = colors[item.id] ?? item.color;
    return color ? { ...item, color, ink: readableInk(color) } : item;
  });
}

/** Nombre de parts d'une roue d'apps ou de partage : six au moins, une par emplacement. */
function slotCount(slots: readonly unknown[]): number {
  return Math.min(Math.max(slots.length, SECTOR_COUNT), MAX_SECTORS);
}

/** Parts de la roue des apps, à partir des apps choisies dans les réglages. `badges` : pastille
 * de notifications de chaque app (macOS), dans le même ordre. */
export function appItems(
  apps: readonly (AppView | null)[],
  badges: readonly (string | null)[] = [],
): WheelItem[] {
  return Array.from({ length: slotCount(apps) }, (_, index) => {
    const app = apps[index];
    if (!app) return { id: `app-${index}`, label: "+", action: "Ajouter une app", empty: true };
    return {
      id: `app-${index}`,
      label: app.name,
      action: `Ouvrir ${app.name}`,
      icon: app.icon ?? undefined,
      badge: badges[index] ?? undefined,
    };
  });
}

/** Ce qu'annonce le centre au survol d'une destination. */
export function shareAction(target: ShareView): string {
  switch (target.kind) {
    case "service":
      return `Envoyer par ${target.name}`;
    case "folder":
      return `Copier dans ${target.name}`;
    case "app":
      return `Copier pour ${target.name}`;
    case "system":
      return "Partager avec…";
  }
}

/** Icône du menu de partage du système : la flèche de partage sur une tuile bleue. */
const SHARE_MENU_ICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5aa9ff"/><stop offset="1" stop-color="#1f6fe5"/>
    </linearGradient></defs>
    <rect x="4" y="4" width="56" height="56" rx="13" fill="url(#g)"/>
    <g fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M32 13v24M24 20.5 32 13l8 7.5"/>
      <path d="M24 28h-4.5a2.5 2.5 0 0 0-2.5 2.5v17a2.5 2.5 0 0 0 2.5 2.5h25a2.5 2.5 0 0 0 2.5-2.5v-17a2.5 2.5 0 0 0-2.5-2.5H40"/>
    </g>
  </svg>`,
)}`;

/** Icône d'une destination : celle du système, ou la nôtre pour le menu de partage. */
export function shareIcon(target: ShareView): string | undefined {
  return target.kind === "system" ? SHARE_MENU_ICON : (target.icon ?? undefined);
}

/** Parts de la roue de partage, à partir des destinations choisies dans les réglages. */
export function shareItems(targets: readonly (ShareView | null)[]): WheelItem[] {
  return Array.from({ length: slotCount(targets) }, (_, index) => {
    const target = targets[index];
    const id = `share-${index}`;
    if (!target) return { id, label: "+", action: "Ajouter un partage", empty: true };
    return { id, label: target.name, action: shareAction(target), icon: shareIcon(target) };
  });
}
