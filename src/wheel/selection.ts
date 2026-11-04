import type { FileInfo } from "../ipc";
import { shortenMiddle } from "./fileName";
import { OUTPUT_FORMATS, type OutputFormat } from "./formats";
import { isInsideHub, sectorAt } from "./geometry";

export type Point = [number, number];

const ALL_FORMATS = new Set<OutputFormat>(OUTPUT_FORMATS.map((format) => format.id));

function isOutputFormat(format: string | null): format is OutputFormat {
  return format !== null && ALL_FORMATS.has(format as OutputFormat);
}

/** Formats grisés : celui d'origine, ou tous si aucun fichier n'est une image lisible. */
export function disabledFormats(files: FileInfo[]): Set<OutputFormat> {
  if (files.length === 0) return new Set();
  if (files.every((file) => file.format === null)) return new Set(ALL_FORMATS);
  const first = files[0].format;
  const sameFormat = files.every((file) => file.format === first);
  return sameFormat && isOutputFormat(first) ? new Set([first]) : new Set();
}

/** Part utilisable sous un point, ou `null` (centre, extérieur, format grisé). */
export function usableSector(x: number, y: number, disabled: Set<OutputFormat>): number | null {
  const index = sectorAt(x, y);
  return index === null || disabled.has(OUTPUT_FORMATS[index].id) ? null : index;
}

export interface HubText {
  label: string;
  /** `action` : format survolé ; `file` : nom du fichier ; `muted` : information secondaire. */
  tone: "action" | "file" | "muted";
  title?: string;
  hint?: string;
}

/** Texte du cercle central pour les fichiers chargés ou glissés. */
export function hubText(files: FileInfo[]): HubText | null {
  if (files.length === 0) return null;
  const unsupported = files.every((file) => file.format === null);
  const hint = unsupported ? "Format non pris en charge" : undefined;
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
  disabled: Set<OutputFormat>,
  files: FileInfo[],
  dragging: boolean,
): HubText | null {
  if (pointer) {
    const index = sectorAt(...pointer);
    if (index !== null) {
      const { id, label } = OUTPUT_FORMATS[index];
      if (!disabled.has(id)) return { label: `Convertir en ${label}`, tone: "action" };
      const unsupported = disabled.size === ALL_FORMATS.size;
      return { label: unsupported ? "Format non pris en charge" : `Déjà en ${label}`, tone: "muted" };
    }
    if (dragging && isInsideHub(...pointer)) return { label: "Relâcher ici pour annuler", tone: "muted" };
  }
  return hubText(files);
}
