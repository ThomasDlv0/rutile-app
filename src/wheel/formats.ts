import type { AppView } from "../ipc";

// Ordre des parts, dans le sens horaire en partant du haut
export const OUTPUT_FORMATS = [
  { id: "png", label: "PNG" },
  { id: "jpeg", label: "JPEG" },
  { id: "webp", label: "WebP" },
  { id: "avif", label: "AVIF" },
  { id: "svg", label: "SVG" },
  { id: "ico", label: "ICO" },
] as const;

export const VIDEO_FORMATS = [
  { id: "mp4", label: "MP4" },
  { id: "webm", label: "WebM" },
  { id: "mov", label: "MOV" },
  { id: "mkv", label: "MKV" },
  { id: "gif", label: "GIF" },
  { id: "mp3", label: "MP3", action: "Extraire le son en MP3" },
] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number]["id"];
export type VideoFormat = (typeof VIDEO_FORMATS)[number]["id"];

/** Les roues entre lesquelles le clic au centre fait passer. */
export type Mode = "image" | "video" | "apps";

export const ALL_MODES: readonly Mode[] = ["image", "video", "apps"];

/** Contenu d'une part de la roue : un format, ou une app. */
export interface WheelItem {
  id: string;
  label: string;
  /** Texte du centre au survol, « Convertir en … » par défaut. */
  action?: string;
  /** Icône d'app, en data URL. */
  icon?: string;
  /** Part de la roue des apps sans app choisie. */
  empty?: boolean;
}

export function formatsFor(mode: "image" | "video"): readonly WheelItem[] {
  return mode === "image" ? OUTPUT_FORMATS : VIDEO_FORMATS;
}

/** Parts de la roue des apps, à partir des apps choisies dans les réglages. */
export function appItems(apps: readonly (AppView | null)[]): WheelItem[] {
  return Array.from({ length: 6 }, (_, index) => {
    const app = apps[index];
    if (!app) return { id: `app-${index}`, label: "+", action: "Ajouter une app", empty: true };
    return { id: `app-${index}`, label: app.name, action: `Ouvrir ${app.name}`, icon: app.icon ?? undefined };
  });
}
