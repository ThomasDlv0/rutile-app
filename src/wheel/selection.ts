import type { FileInfo } from "../ipc";
import { shortenMiddle } from "./fileName";
import { type Mode, type WheelItem, formatsFor } from "./formats";
import { isInsideHub, sectorAt } from "./geometry";

export type Point = [number, number];

/** Vidéos qui ont leur propre part sur la roue (leur format y est grisé). */
const VIDEO_ON_WHEEL = new Set(["mp4", "webm", "mov", "mkv"]);

/** Ce qu'annonce le centre au survol : la roue suivante dans l'ordre des réglages. */
const SWITCH_LABELS: Record<Mode, string> = {
  image: "Passer aux images",
  video: "Passer en vidéo",
  apps: "Passer aux apps",
  share: "Passer au partage",
};

/** Le fichier peut-il être traité dans ce mode ? Un GIF animé passe aussi en vidéo, et
 * n'importe quel fichier peut s'ouvrir avec une app ou se partager. */
export function convertible(file: FileInfo, mode: Mode): boolean {
  if (mode === "apps" || mode === "share") return true;
  return mode === "image" ? file.format !== null : file.video !== null || file.format === "gif";
}

/** Part de la roue qui correspond au format d'origine du fichier, s'il y en a une. */
function sourceFormat(file: FileInfo, mode: "image" | "video"): string | null {
  if (mode === "video") {
    if (file.video && VIDEO_ON_WHEEL.has(file.video)) return file.video;
    return file.format === "gif" ? "gif" : null;
  }
  const ids = formatsFor("image").map((format) => format.id);
  return file.format && ids.includes(file.format) ? file.format : null;
}

/** Formats grisés : celui d'origine, ou tous si aucun fichier n'est convertible dans ce mode.
 * Rien n'est grisé sur les roues des apps et de partage. */
export function disabledFormats(files: FileInfo[], mode: Mode): Set<string> {
  if (mode === "apps" || mode === "share" || files.length === 0) return new Set();
  const all = new Set<string>(formatsFor(mode).map((format) => format.id));
  if (!files.some((file) => convertible(file, mode))) return all;
  const first = sourceFormat(files[0], mode);
  const sameFormat = files.every((file) => sourceFormat(file, mode) === first);
  return sameFormat && first !== null ? new Set([first]) : new Set();
}

/** Mode adapté aux fichiers : vidéo si ce ne sont que des vidéos, image si ce ne sont que
 * des images ; `null` pour un mélange ou un GIF, qui va dans les deux. */
export function preferredMode(files: FileInfo[]): "image" | "video" | null {
  if (files.length === 0) return null;
  if (files.every((file) => file.video !== null)) return "video";
  if (files.every((file) => file.format !== null && file.format !== "gif")) return "image";
  return null;
}

/** Roue qui suit `mode` dans l'ordre des réglages, ou `null` s'il n'y en a qu'une. */
export function nextMode(modes: readonly Mode[], mode: Mode): Mode | null {
  if (modes.length < 2) return null;
  const index = modes.indexOf(mode);
  return modes[(index + 1) % modes.length];
}

/** Part utilisable sous un point, ou `null` (centre, extérieur, format grisé). */
export function usableSector(
  x: number,
  y: number,
  disabled: Set<string>,
  items: readonly WheelItem[],
): number | null {
  const index = sectorAt(x, y, items.length);
  return index === null || disabled.has(items[index].id) ? null : index;
}

export interface HubText {
  label: string;
  /** `action` : part survolée ; `file` : nom du fichier ; `muted` : information secondaire. */
  tone: "action" | "file" | "muted";
  title?: string;
  hint?: string;
}

/** Texte du cercle central pour les fichiers chargés ou glissés. */
export function hubText(files: FileInfo[], mode: Mode): HubText | null {
  if (files.length === 0) return null;
  const unsupported = !files.some((file) => convertible(file, mode));
  const hint = unsupported
    ? mode === "image"
      ? "Format non pris en charge"
      : "Ce n'est pas une vidéo"
    : undefined;
  if (files.length === 1) {
    const { name } = files[0];
    return { label: shortenMiddle(name, unsupported ? 18 : 22), tone: "file", title: name, hint };
  }
  return {
    label: `${files.length} fichiers`,
    tone: "file",
    title: files.map((file) => file.name).join("\n"),
    hint,
  };
}

/** Texte du survol d'une part : convertir, ouvrir une app, ou en ajouter une. */
function itemAction(item: WheelItem, dragging: boolean, mode: Mode): string {
  if (mode === "apps" && !item.empty && dragging) return `Ouvrir avec ${item.label}`;
  return item.action ?? `Convertir en ${item.label}`;
}

/** Le centre décrit ce que fera la roue à l'endroit pointé, sinon le fichier en cours.
 * `dwellTarget` : pendant un glisser, roue où mène un temps passé au centre. */
export function hubFor(
  pointer: Point | null,
  disabled: Set<string>,
  files: FileInfo[],
  dragging: boolean,
  mode: Mode,
  items: readonly WheelItem[],
  next: Mode | null,
  dwellTarget: Mode | null = null,
): HubText | null {
  if (pointer) {
    const index = sectorAt(...pointer, items.length);
    if (index !== null) {
      const item = items[index];
      if (!disabled.has(item.id)) {
        return { label: itemAction(item, dragging, mode), tone: "action" };
      }
      const nothingConvertible = disabled.size === items.length;
      return {
        label: nothingConvertible ? "Format non pris en charge" : `Déjà en ${item.label}`,
        tone: "muted",
      };
    }
    if (isInsideHub(...pointer)) {
      if (dragging && dwellTarget) {
        const label = dwellTarget === "share" ? "Restez pour partager" : "Restez pour convertir";
        return { label, tone: "action", hint: "Relâchez pour annuler" };
      }
      if (dragging) return { label: "Relâcher ici pour annuler", tone: "muted" };
      if (next) return { label: SWITCH_LABELS[next], tone: "action" };
    }
  }
  return hubText(files, mode);
}
