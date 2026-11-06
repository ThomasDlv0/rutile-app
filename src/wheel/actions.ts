import type {
  ActionRequest,
  CustomWheelView,
  FileInfo,
  WheelConfig,
} from "../ipc";
import { readableInk } from "./color";
import type { GlyphName } from "./ActionGlyph";
import type { VideoFormat, WheelItem } from "./formats";
import { MAX_SECTORS } from "./geometry";

/** Fichiers qu'une action sait traiter. */
export type FileNeed = "images" | "videos" | "pdfs" | "files";

/** Part de la roue Actions. Un clic lance `run` s'il y en a un, sinon ouvre `children` ;
 * rester sur la part ouvre aussi `children`. */
export interface ActionNode extends WheelItem {
  glyph: GlyphName;
  /** Ce qui se passe au clic. */
  run?: ActionRequest;
  /** Conversion de la roue Vidéo, reprise telle quelle. */
  convert?: VideoFormat;
  /** Fichiers à traiter : ceux de la roue, ou choisis au moment du clic. */
  needs?: FileNeed;
  /** La roue se ferme d'abord, pour laisser l'écran libre (capture, pipette, fenêtres). */
  hides?: boolean;
  /** Reçoit les fichiers de la roue s'il y en a, sans en demander (action personnalisée). */
  takesFiles?: boolean;
  children?: readonly ActionNode[];
  /** Passe sur une autre roue. */
  goesTo?: "apps";
  /** Ouvre les réglages sur l'onglet des actions. */
  setup?: boolean;
}

const BLUE = "#3b82f6";
const GREEN = "#16a34a";
const PINK = "#ec4899";
const ORANGE = "#f97316";
const VIOLET = "#8b5cf6";
const RED = "#e5484d";
const SLATE = "#64748b";
const TEAL = "#0d9488";
const YELLOW = "#f2b705";

const CAPTURE: readonly ActionNode[] = [
  {
    id: "capture-zone",
    label: "Zone",
    action: "Capturer une zone",
    glyph: "zone",
    hides: true,
    run: { kind: "capture", target: "zone", delay: 0 },
  },
  {
    id: "capture-window",
    label: "Fenêtre",
    action: "Capturer une fenêtre",
    glyph: "window",
    hides: true,
    run: { kind: "capture", target: "window", delay: 0 },
  },
  {
    id: "capture-screen",
    label: "Écran",
    action: "Capturer tout l'écran",
    glyph: "screen",
    hides: true,
    run: { kind: "capture", target: "screen", delay: 0 },
  },
  {
    id: "capture-timer",
    label: "3 s",
    action: "Capturer l'écran dans 3 secondes",
    glyph: "timer",
    hides: true,
    run: { kind: "capture", target: "screen", delay: 3 },
  },
];

const COLOR: readonly ActionNode[] = (["hex", "rgb", "hsl"] as const).map((format) => ({
  id: `color-${format}`,
  label: format.toUpperCase(),
  action: `Copier la couleur en ${format.toUpperCase()}`,
  glyph: "color",
  hides: true,
  run: { kind: "color", format },
}));

const RENAME: readonly ActionNode[] = [
  { style: "number", label: "Numéros", action: "Numéroter les fichiers", glyph: "number" },
  { style: "date", label: "Date", action: "Ajouter la date au nom", glyph: "date" },
  { style: "lowercase", label: "Minuscules", action: "Passer en minuscules", glyph: "lower" },
  { style: "clean", label: "Nettoyer", action: "Retirer accents et espaces", glyph: "clean" },
].map(({ style, ...item }) => ({
  ...item,
  id: `rename-${style}`,
  glyph: item.glyph as GlyphName,
  needs: "files" as const,
  run: { kind: "rename", style } as ActionRequest,
}));

const FILES: readonly ActionNode[] = [
  {
    id: "files-zip",
    label: "ZIP",
    action: "Créer un ZIP",
    glyph: "zip",
    needs: "files",
    run: { kind: "zip" },
  },
  {
    id: "files-pdf",
    label: "PDF",
    action: "Assembler les images en PDF",
    glyph: "pdf",
    needs: "images",
    run: { kind: "imagesToPdf" },
  },
  {
    id: "files-merge",
    label: "Fusion",
    action: "Fusionner les PDF",
    glyph: "merge",
    needs: "pdfs",
    run: { kind: "mergePdfs" },
  },
  {
    id: "files-rename",
    label: "Renommer",
    action: "Renommer en lot",
    glyph: "rename",
    children: RENAME,
  },
];

const IMAGE: readonly ActionNode[] = [
  { id: "half", label: "Moitié", action: "Réduire de moitié", glyph: "half", retouch: "half" },
  { id: "fullHd", label: "1920", action: "Réduire à 1920 pixels", glyph: "full", retouch: "fullHd" },
  { id: "compress", label: "Alléger", action: "Compresser", glyph: "compress", retouch: "compress" },
  {
    id: "strip",
    label: "Métadonnées",
    action: "Retirer les métadonnées",
    glyph: "shield",
    retouch: "stripMetadata",
  },
].map(({ id, retouch, ...item }) => ({
  ...item,
  id: `image-${id}`,
  glyph: item.glyph as GlyphName,
  needs: "images" as const,
  run: { kind: "retouch", retouch } as ActionRequest,
}));

const VIDEO: readonly ActionNode[] = [
  {
    id: "video-compress",
    label: "Alléger",
    action: "Compresser la vidéo",
    glyph: "compress",
    needs: "videos",
    run: { kind: "video", rework: { kind: "compress" } },
  },
  ...[10, 25].map(
    (megabytes): ActionNode => ({
      id: `video-fit-${megabytes}`,
      label: `${megabytes} Mo`,
      action: `Réduire à ${megabytes} Mo`,
      glyph: "compress",
      needs: "videos",
      run: { kind: "video", rework: { kind: "fit", megabytes } },
    }),
  ),
  {
    id: "video-gif",
    label: "GIF",
    action: "Convertir en GIF",
    glyph: "gif",
    needs: "videos",
    convert: "gif",
  },
  {
    id: "video-mp3",
    label: "MP3",
    action: "Extraire le son en MP3",
    glyph: "music",
    needs: "videos",
    convert: "mp3",
  },
  {
    id: "video-mute",
    label: "Muet",
    action: "Retirer le son",
    glyph: "mute",
    needs: "videos",
    run: { kind: "video", rework: { kind: "mute" } },
  },
];

const WINDOWS: readonly ActionNode[] = [
  { layout: "left", label: "Gauche", action: "Moitié gauche de l'écran", glyph: "left" },
  { layout: "right", label: "Droite", action: "Moitié droite de l'écran", glyph: "right" },
  { layout: "top", label: "Haut", action: "Moitié haute de l'écran", glyph: "top" },
  { layout: "bottom", label: "Bas", action: "Moitié basse de l'écran", glyph: "bottom" },
  { layout: "maximize", label: "Agrandir", action: "Remplir l'écran", glyph: "full" },
  { layout: "center", label: "Centrer", action: "Centrer la fenêtre", glyph: "center" },
].map(({ layout, ...item }) => ({
  ...item,
  id: `windows-${layout}`,
  glyph: item.glyph as GlyphName,
  hides: true,
  run: { kind: "place", layout } as ActionRequest,
}));

/** Actions d'une roue personnalisée. */
function customActions(wheel: CustomWheelView, index: number): ActionNode[] {
  return wheel.actions.slice(0, MAX_SECTORS).map((action, slot) => ({
    id: `custom-${index}-${slot}`,
    label: action.name,
    action: action.name,
    glyph: "play",
    hides: action.kind === "shortcut",
    takesFiles: true,
    run: { kind: "custom", wheel: index, action: slot },
  }));
}

/** Part « Mes roues » : directement les actions s'il n'y a qu'une roue. */
function customNode(wheels: readonly CustomWheelView[]): ActionNode {
  const base = { id: "action-custom", label: "Mes roues", glyph: "wheels" as const, color: YELLOW };
  const usable = wheels.filter((wheel) => wheel.actions.length > 0).slice(0, MAX_SECTORS);
  if (usable.length === 0) {
    return { ...base, action: "Créer une roue personnalisée", setup: true };
  }
  if (usable.length === 1) {
    return { ...base, action: usable[0].name, children: customActions(usable[0], wheels.indexOf(usable[0])) };
  }
  return {
    ...base,
    action: "Mes roues personnalisées",
    children: usable.map((wheel) => {
      const index = wheels.indexOf(wheel);
      return {
        id: `custom-wheel-${index}`,
        label: wheel.name,
        action: wheel.name,
        glyph: "wheels",
        children: customActions(wheel, index),
      };
    }),
  };
}

/** Parts de la roue Actions, dans le sens horaire depuis le haut. */
export function actionTree(config: Pick<WheelConfig, "custom" | "windowLayout">): ActionNode[] {
  const tree: ActionNode[] = [
    {
      id: "action-capture",
      label: "Capture",
      action: "Capturer une zone",
      hint: "Restez pour les options",
      glyph: "capture",
      color: BLUE,
      hides: true,
      run: { kind: "capture", target: "zone", delay: 0 },
      children: CAPTURE,
    },
    {
      id: "action-text",
      label: "Texte",
      action: "Copier le texte d'une zone",
      glyph: "text",
      color: GREEN,
      hides: true,
      run: { kind: "text" },
    },
    {
      id: "action-color",
      label: "Couleur",
      action: "Copier une couleur de l'écran",
      hint: "Restez pour les formats",
      glyph: "color",
      color: PINK,
      hides: true,
      run: { kind: "color", format: "hex" },
      children: COLOR,
    },
    {
      id: "action-files",
      label: "Fichiers",
      action: "ZIP, PDF, renommer…",
      glyph: "files",
      color: ORANGE,
      children: FILES,
    },
    {
      id: "action-image",
      label: "Image",
      action: "Réduire, compresser…",
      glyph: "image",
      color: VIOLET,
      children: IMAGE,
    },
    {
      id: "action-video",
      label: "Vidéo",
      action: "Compresser, GIF, MP3…",
      glyph: "video",
      color: RED,
      children: VIDEO,
    },
  ];
  if (config.windowLayout) {
    tree.push({
      id: "action-windows",
      label: "Fenêtres",
      action: "Ranger la fenêtre active",
      glyph: "grid",
      color: SLATE,
      children: WINDOWS,
    });
  }
  tree.push(
    {
      id: "action-apps",
      label: "Apps",
      action: "Passer aux apps",
      glyph: "star",
      color: TEAL,
      goesTo: "apps",
    },
    customNode(config.custom),
  );
  return tree;
}

/** Couleurs choisies dans les réglages, et celle de la part de départ sur ses sous-roues. */
export function colorizeActions(
  nodes: readonly ActionNode[],
  colors: Readonly<Record<string, string>>,
  inherited?: string,
): ActionNode[] {
  return nodes.map((node) => {
    const color = colors[node.id] ?? inherited ?? node.color;
    const children = node.children && colorizeActions(node.children, colors, color);
    return { ...node, children, color, ink: color ? readableInk(color) : undefined };
  });
}

/** Parts affichées au bout du chemin `path` : un index par sous-roue ouverte. */
export function actionsAt(
  tree: readonly ActionNode[],
  path: readonly number[],
): readonly ActionNode[] {
  let nodes = tree;
  for (const index of path) {
    const children = nodes[index]?.children;
    if (!children) return nodes;
    nodes = children;
  }
  return nodes;
}

/** Part dont on a ouvert la sous-roue, `null` à la racine. */
export function actionParent(
  tree: readonly ActionNode[],
  path: readonly number[],
): ActionNode | null {
  if (path.length === 0) return null;
  return actionsAt(tree, path.slice(0, -1))[path[path.length - 1]] ?? null;
}

const isPdf = (file: FileInfo) => file.name.toLowerCase().endsWith(".pdf");

/** Le fichier convient-il à l'action ? */
function suits(file: FileInfo, need: FileNeed): boolean {
  switch (need) {
    case "images":
      return file.format !== null;
    case "videos":
      return file.video !== null || file.format === "gif";
    case "pdfs":
      return isPdf(file);
    case "files":
      return true;
  }
}

/** Fichiers que l'action traitera ; une action sans besoin n'en prend aucun. */
export function filesFor(node: ActionNode, files: readonly FileInfo[]): FileInfo[] {
  const { needs } = node;
  if (node.takesFiles) return [...files];
  return needs ? files.filter((file) => suits(file, needs)) : [];
}

/** Parts grisées : celles dont aucun des fichiers connus ne convient. */
export function disabledActions(
  nodes: readonly ActionNode[],
  files: readonly FileInfo[],
): Set<string> {
  if (files.length === 0) return new Set();
  return new Set(
    nodes
      .filter((node) => node.needs && filesFor(node, files).length === 0)
      .map((node) => node.id),
  );
}

/** Une sous-roue s'ouvre en restant sur la part. */
export const opensOnDwell = (node: ActionNode | undefined): boolean =>
  node?.children !== undefined;
