import type { FileInfo } from "../ipc";
import { shortenMiddle } from "./fileName";
import {
  type Mode,
  type WheelItem,
  formatsFor,
  isCustomMode,
  isTreeMode,
} from "./formats";
import { isInsideHub, sectorAt } from "./geometry";
import { t, tn } from "../i18n";

export type Point = [number, number];

/** Vidéos qui ont leur propre part sur la roue (leur format y est grisé). */
const VIDEO_ON_WHEEL = new Set(["mp4", "webm", "mov", "mkv"]);

/** Ce qu'annonce le centre au survol : la roue suivante dans l'ordre des réglages. */
/** Annonce du passage à la roue `mode` ; `name` est le nom d'une roue personnalisée. */
export function switchLabel(mode: Mode, name?: string): string {
  if (isCustomMode(mode)) {
    return name ? t("wheel.switch.custom", { name }) : t("wheel.switch.customUnnamed");
  }
  return t(`wheel.switch.${mode}`);
}

/** Les roues de conversion, seules à griser des formats. */
const isConverter = (mode: Mode): mode is "image" | "video" =>
  mode === "image" || mode === "video";

/** Le fichier peut-il être traité dans ce mode ? Un GIF animé passe aussi en vidéo, et
 * n'importe quel fichier peut s'ouvrir avec une app ou se partager. */
export function convertible(file: FileInfo, mode: Mode): boolean {
  if (!isConverter(mode)) return true;
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
  if (!isConverter(mode) || files.length === 0) return new Set();
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

/** Roue qui suit `mode` dans l'ordre des réglages (celle d'avant pour `step` -1), ou `null`
 * s'il n'y en a qu'une. */
export function nextMode(modes: readonly Mode[], mode: Mode, step: 1 | -1 = 1): Mode | null {
  const index = modes.indexOf(mode);
  // La roue affichée n'est plus dans la liste (elle ne convient pas aux fichiers arrivés
  // depuis) : la première roue la remplace
  if (index < 0) return modes[0] ?? null;
  if (modes.length < 2) return null;
  return modes[(index + step + modes.length) % modes.length];
}

/** Part choisie au clavier depuis `from` : la suivante dans le sens horaire (`step` 1) ou la
 * précédente, en sautant les formats grisés. Sans part de départ, on part du haut (la part 0)
 * ou de la dernière. `null` si aucune part n'est utilisable. */
export function stepSector(
  from: number | null,
  step: 1 | -1,
  disabled: Set<string>,
  items: readonly WheelItem[],
): number | null {
  const count = items.length;
  let index = from ?? (step === 1 ? -1 : 0);
  for (let tried = 0; tried < count; tried++) {
    index = (index + step + count) % count;
    if (!disabled.has(items[index].id)) return index;
  }
  return null;
}

/** Part d'une touche chiffre : 1 pour la première (en haut), puis dans le sens horaire, 0 pour
 * la dixième. Lue par `KeyboardEvent.code`, elle marche sans Maj sur un clavier AZERTY. */
export function digitSector(code: string, count: number): number | null {
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code)?.[1];
  if (digit === undefined) return null;
  const index = digit === "0" ? 9 : Number(digit) - 1;
  return index < count ? index : null;
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
      ? t("wheel.hub.unsupportedFormat")
      : t("wheel.hub.notVideo")
    : undefined;
  if (files.length === 1) {
    const { name } = files[0];
    return { label: shortenMiddle(name, unsupported ? 18 : 22), tone: "file", title: name, hint };
  }
  return {
    label: tn("wheel.hub.files", files.length),
    tone: "file",
    title: files.map((file) => file.name).join("\n"),
    hint,
  };
}

/** Texte du survol d'une part : convertir, ouvrir une app, ou en ajouter une. */
function itemAction(item: WheelItem, dragging: boolean, mode: Mode): string {
  if (dragging && item.dragAction) return item.dragAction;
  if (mode === "apps" && !item.empty && dragging) return t("wheel.openWith", { name: item.label });
  return item.action ?? t("wheel.convertTo", { format: item.label });
}

/** Le centre décrit ce que fera la roue à l'endroit pointé, sinon le fichier en cours.
 * `dwellTarget` : pendant un glisser, roue où mène un temps passé au centre. `nextName` : nom
 * de la roue suivante, si c'est une roue personnalisée. */
export function hubFor(
  pointer: Point | null,
  disabled: Set<string>,
  files: FileInfo[],
  dragging: boolean,
  mode: Mode,
  items: readonly WheelItem[],
  next: Mode | null,
  dwellTarget: Mode | null = null,
  back = false,
  nextName?: string,
): HubText | null {
  if (pointer) {
    const index = sectorAt(...pointer, items.length);
    if (index !== null) {
      const item = items[index];
      if (!disabled.has(item.id)) {
        return { label: itemAction(item, dragging, mode), tone: "action", hint: item.hint };
      }
      if (isTreeMode(mode)) return { label: t("wheel.hub.notForFiles"), tone: "muted" };
      const nothingConvertible = disabled.size === items.length;
      return {
        label: nothingConvertible
          ? t("wheel.hub.unsupportedFormat")
          : t("wheel.hub.alreadyIn", { format: item.label }),
        tone: "muted",
      };
    }
    if (isInsideHub(...pointer)) {
      if (dragging && dwellTarget) {
        const label = dwellTarget === "share" ? t("wheel.hub.dwellShare") : t("wheel.hub.dwellConvert");
        return { label, tone: "action", hint: t("wheel.hub.releaseToCancel") };
      }
      if (dragging) return { label: t("wheel.hub.releaseHereToCancel"), tone: "muted" };
      if (back) return { label: t("wheel.hub.backLabel"), tone: "action" };
      if (next) return { label: switchLabel(next, nextName), tone: "action" };
    }
  }
  return hubText(files, mode);
}
