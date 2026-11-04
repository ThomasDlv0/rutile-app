import type { FileInfo } from "../ipc";
import { shortenMiddle } from "./fileName";
import { type Mode, formatsFor } from "./formats";
import { isInsideHub, sectorAt } from "./geometry";

export type Point = [number, number];

/** Vidéos qui ont leur propre part sur la roue (leur format y est grisé). */
const VIDEO_ON_WHEEL = new Set(["mp4", "webm", "mov", "mkv"]);

/** Le fichier peut-il être converti dans ce mode ? Un GIF animé passe aussi en vidéo. */
export function convertible(file: FileInfo, mode: Mode): boolean {
  return mode === "image" ? file.format !== null : file.video !== null || file.format === "gif";
}

/** Part de la roue qui correspond au format d'origine du fichier, s'il y en a une. */
function sourceFormat(file: FileInfo, mode: Mode): string | null {
  if (mode === "video") {
    if (file.video && VIDEO_ON_WHEEL.has(file.video)) return file.video;
    return file.format === "gif" ? "gif" : null;
  }
  const ids = formatsFor("image").map((format) => format.id as string);
  return file.format && ids.includes(file.format) ? file.format : null;
}

/** Formats grisés : celui d'origine, ou tous si aucun fichier n'est convertible dans ce mode. */
export function disabledFormats(files: FileInfo[], mode: Mode): Set<string> {
  const all = new Set<string>(formatsFor(mode).map((format) => format.id));
  if (files.length === 0) return new Set();
  if (!files.some((file) => convertible(file, mode))) return all;
  const first = sourceFormat(files[0], mode);
  const sameFormat = files.every((file) => sourceFormat(file, mode) === first);
  return sameFormat && first !== null ? new Set([first]) : new Set();
}

/** Mode adapté aux fichiers : vidéo si ce ne sont que des vidéos, image si ce ne sont que
 * des images ; `null` pour un mélange ou un GIF, qui va dans les deux. */
export function preferredMode(files: FileInfo[]): Mode | null {
  if (files.length === 0) return null;
  if (files.every((file) => file.video !== null)) return "video";
  if (files.every((file) => file.format !== null && file.format !== "gif")) return "image";
  return null;
}

/** Part utilisable sous un point, ou `null` (centre, extérieur, format grisé). */
export function usableSector(
  x: number,
  y: number,
  disabled: Set<string>,
  mode: Mode,
): number | null {
  const index = sectorAt(x, y);
  return index === null || disabled.has(formatsFor(mode)[index].id) ? null : index;
}

export interface HubText {
  label: string;
  /** `action` : format survolé ; `file` : nom du fichier ; `muted` : information secondaire. */
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

/** Le centre décrit ce que fera la roue à l'endroit pointé, sinon le fichier en cours. */
export function hubFor(
  pointer: Point | null,
  disabled: Set<string>,
  files: FileInfo[],
  dragging: boolean,
  mode: Mode,
): HubText | null {
  if (pointer) {
    const index = sectorAt(...pointer);
    if (index !== null) {
      const format = formatsFor(mode)[index];
      if (!disabled.has(format.id)) {
        return { label: format.action ?? `Convertir en ${format.label}`, tone: "action" };
      }
      const nothingConvertible = disabled.size === formatsFor(mode).length;
      return {
        label: nothingConvertible ? "Format non pris en charge" : `Déjà en ${format.label}`,
        tone: "muted",
      };
    }
    if (isInsideHub(...pointer)) {
      if (dragging) return { label: "Relâcher ici pour annuler", tone: "muted" };
      return { label: mode === "image" ? "Passer en vidéo" : "Passer en images", tone: "action" };
    }
  }
  return hubText(files, mode);
}
