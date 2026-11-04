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

/** Le clic au centre de la roue passe d'un mode à l'autre. */
export type Mode = "image" | "video";

export interface WheelFormat {
  id: OutputFormat | VideoFormat;
  label: string;
  /** Texte du centre au survol, « Convertir en … » par défaut. */
  action?: string;
}

export function formatsFor(mode: Mode): readonly WheelFormat[] {
  return mode === "image" ? OUTPUT_FORMATS : VIDEO_FORMATS;
}
