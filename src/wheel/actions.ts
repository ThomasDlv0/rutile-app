import type {
  ActionRequest,
  CustomPartView,
  CustomWheelView,
  FileInfo,
  FileKind,
  FileWheels,
  PartEntry,
  WheelConfig,
} from "../ipc";
import { readableInk } from "./color";
import type { GlyphName } from "./ActionGlyph";
import {
  type Mode,
  OUTPUT_FORMATS,
  type OutputFormat,
  VIDEO_FORMATS,
  type VideoFormat,
  WEB_ICON,
  type WheelItem,
  customIndex,
  isCustomMode,
} from "./formats";
import { MAX_SECTORS } from "./geometry";
import { t } from "../i18n";

/** Fichiers qu'une action sait traiter. */
export type FileNeed = "images" | "videos" | "pdfs" | "archives" | "files";

/** Part de la roue Actions ou d'une roue personnalisée. Un clic lance `run` s'il y en a un,
 * sinon ouvre `children` ; rester sur la part ouvre aussi `children`. */
export interface ActionNode extends WheelItem {
  /** Ce qui se passe au clic. */
  run?: ActionRequest;
  /** Conversion de la roue Vidéo, reprise telle quelle. */
  convert?: VideoFormat;
  /** Conversion de la roue Images, reprise telle quelle. */
  convertImage?: OutputFormat;
  /** La part ouvre une app, un dossier ou un site : le centre l'annonce comme tel. */
  opens?: boolean;
  /** Fichiers à traiter : ceux de la roue, ou choisis au moment du clic. */
  needs?: FileNeed;
  /** La roue se ferme d'abord, pour laisser l'écran libre (capture, pipette, fenêtres). */
  hides?: boolean;
  /** Reçoit les fichiers de la roue s'il y en a, sans en demander (action personnalisée). */
  takesFiles?: boolean;
  children?: readonly ActionNode[];
  /** Passe sur une autre roue. */
  goesTo?: "apps";
  /** Nombre de fichiers qui conviennent, au moins et au plus, pour que l'action ait un sens. */
  least?: number;
  most?: number;
  /** Part de la roue Actions dont l'action reprend la couleur, sur la roue d'un fichier. */
  family?: string;
  /** Masquée tant que l'utilisateur ne l'a pas affichée dans les réglages. */
  offByDefault?: boolean;
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

/** Noms des parts du catalogue : leurs textes sont dans `wheel.json`, sous `wheel.actions`. */
type PartName =
  | "group.capture"
  | "group.text"
  | "group.color"
  | "group.files"
  | "group.image"
  | "group.video"
  | "group.windows"
  | "group.apps"
  | "capture.zone"
  | "capture.window"
  | "capture.screen"
  | "capture.timer"
  | "rename.number"
  | "rename.date"
  | "rename.lowercase"
  | "rename.clean"
  | "files.zip"
  | "files.extract"
  | "files.pdf"
  | "files.merge"
  | "files.rename"
  | "files.path"
  | "pdf.text"
  | "image.text"
  | "image.copy"
  | "image.half"
  | "image.fullHd"
  | "image.compress"
  | "image.strip"
  | "video.compress"
  | "video.fit"
  | "video.gif"
  | "video.mp3"
  | "video.mute"
  | "windows.left"
  | "windows.right"
  | "windows.top"
  | "windows.bottom"
  | "windows.maximize"
  | "windows.center";

type PartFields = Omit<ActionNode, "label" | "action" | "hint">;
type PartTexts = { label?: () => string; action?: () => string; hint?: () => string };

/** Une part dont le libellé, l'action et l'indice se lisent à chaque usage, dans la langue
 * en cours : ce sont des accesseurs, pas des textes figés au chargement du module. */
function entry(fields: PartFields, name: PartName, texts: PartTexts = {}): ActionNode {
  const read = (read: (() => string) | undefined, fallback: () => string) => ({
    get: read ?? fallback,
    enumerable: true,
    configurable: true,
  });
  const descriptors: PropertyDescriptorMap = {
    label: read(texts.label, () => t(`wheel.actions.${name}.label`)),
    action: read(texts.action, () => t(`wheel.actions.${name}.action`)),
  };
  if (texts.hint) descriptors.hint = read(texts.hint, texts.hint);
  return Object.defineProperties({ ...fields }, descriptors) as ActionNode;
}

/** Comme `{ ...node, ...extra }`, mais sans figer les accesseurs des textes. */
function extend(node: ActionNode, extra: Partial<ActionNode>): ActionNode {
  return Object.defineProperties(
    {},
    { ...Object.getOwnPropertyDescriptors(node), ...Object.getOwnPropertyDescriptors(extra) },
  ) as ActionNode;
}

const CAPTURE: readonly ActionNode[] = [
  entry(
    {
      id: "capture-zone",
      glyph: "zone",
      hides: true,
      run: { kind: "capture", target: "zone", delay: 0 },
    },
    "capture.zone",
  ),
  entry(
    {
      id: "capture-window",
      glyph: "window",
      hides: true,
      run: { kind: "capture", target: "window", delay: 0 },
    },
    "capture.window",
  ),
  entry(
    {
      id: "capture-screen",
      glyph: "screen",
      hides: true,
      run: { kind: "capture", target: "screen", delay: 0 },
    },
    "capture.screen",
  ),
  entry(
    {
      id: "capture-timer",
      glyph: "timer",
      hides: true,
      run: { kind: "capture", target: "screen", delay: 3 },
    },
    "capture.timer",
  ),
];

const COLOR: readonly ActionNode[] = (["hex", "rgb", "hsl"] as const).map((format) => ({
  id: `color-${format}`,
  label: format.toUpperCase(),
  get action() {
    return t("wheel.actions.color.copy", { format: format.toUpperCase() });
  },
  glyph: "color",
  hides: true,
  run: { kind: "color", format },
}));

const FILES_FAMILY = { family: "action-files", color: ORANGE } as const;
const IMAGE_FAMILY = { family: "action-image", color: VIOLET } as const;
const VIDEO_FAMILY = { family: "action-video", color: RED } as const;
const TEXT_FAMILY = { family: "action-text", color: GREEN } as const;

const renamePart = (style: Extract<ActionRequest, { kind: "rename" }>["style"], glyph: GlyphName) =>
  entry(
    { id: `rename-${style}`, glyph, needs: "files", run: { kind: "rename", style } },
    `rename.${style}`,
  );

const RENAME: readonly ActionNode[] = [
  renamePart("number", "number"),
  renamePart("date", "date"),
  renamePart("lowercase", "lower"),
  renamePart("clean", "clean"),
];

const ZIP = entry(
  { id: "files-zip", glyph: "zip", needs: "files", run: { kind: "zip" }, ...FILES_FAMILY },
  "files.zip",
);

const EXTRACT = entry(
  {
    id: "archive-extract",
    glyph: "unzip",
    needs: "archives",
    run: { kind: "extract" },
    ...FILES_FAMILY,
  },
  "files.extract",
);

const IMAGES_PDF = entry(
  { id: "files-pdf", glyph: "pdf", needs: "images", run: { kind: "imagesToPdf" }, ...FILES_FAMILY },
  "files.pdf",
);

const MERGE = entry(
  {
    id: "files-merge",
    glyph: "merge",
    needs: "pdfs",
    least: 2,
    run: { kind: "mergePdfs" },
    ...FILES_FAMILY,
  },
  "files.merge",
);

const RENAME_NODE = entry(
  { id: "files-rename", glyph: "rename", children: RENAME, ...FILES_FAMILY },
  "files.rename",
  { hint: () => t("wheel.actions.files.rename.hint") },
);

const PATHS = entry(
  { id: "files-path", glyph: "link", needs: "files", run: { kind: "copyPaths" }, ...FILES_FAMILY },
  "files.path",
);

const PDF_TEXT = entry(
  { id: "pdf-text", glyph: "text", needs: "pdfs", run: { kind: "pdfText" }, ...TEXT_FAMILY },
  "pdf.text",
);

const IMAGE_TEXT = entry(
  { id: "image-text", glyph: "text", needs: "images", run: { kind: "readText" }, ...TEXT_FAMILY },
  "image.text",
);

const IMAGE_COPY = entry(
  {
    id: "image-copy",
    glyph: "copy",
    needs: "images",
    most: 1,
    run: { kind: "copyImage" },
    ...IMAGE_FAMILY,
  },
  "image.copy",
);

const FILES: readonly ActionNode[] = [ZIP, EXTRACT, IMAGES_PDF, MERGE, RENAME_NODE];

const imagePart = (
  id: string,
  retouch: Extract<ActionRequest, { kind: "retouch" }>["retouch"],
  glyph: GlyphName,
  name: PartName,
  texts?: PartTexts,
) =>
  entry(
    {
      id: `image-${id}`,
      glyph,
      needs: "images",
      run: { kind: "retouch", retouch },
      ...IMAGE_FAMILY,
    },
    name,
    texts,
  );

const IMAGE: readonly ActionNode[] = [
  imagePart("half", "half", "half", "image.half"),
  imagePart("fullHd", "fullHd", "full", "image.fullHd"),
  imagePart("compress", "compress", "compress", "image.compress"),
  imagePart("strip", "stripMetadata", "shield", "image.strip"),
];

const VIDEO: readonly ActionNode[] = [
  entry(
    {
      id: "video-compress",
      glyph: "compress",
      needs: "videos",
      run: { kind: "video", rework: { kind: "compress" } },
    },
    "video.compress",
  ),
  ...[10, 25].map((megabytes) =>
    entry(
      {
        id: `video-fit-${megabytes}`,
        glyph: "compress",
        needs: "videos",
        run: { kind: "video", rework: { kind: "fit", megabytes } },
      },
      "video.fit",
      {
        label: () => t("wheel.actions.video.fit.label", { megabytes }),
        action: () => t("wheel.actions.video.fit.action", { megabytes }),
      },
    ),
  ),
  entry({ id: "video-gif", glyph: "gif", needs: "videos", convert: "gif" }, "video.gif"),
  entry({ id: "video-mp3", glyph: "music", needs: "videos", convert: "mp3" }, "video.mp3"),
  entry(
    {
      id: "video-mute",
      glyph: "mute",
      needs: "videos",
      run: { kind: "video", rework: { kind: "mute" } },
    },
    "video.mute",
  ),
].map((node) => extend(node, VIDEO_FAMILY));

const windowPart = (
  layout: Extract<ActionRequest, { kind: "place" }>["layout"],
  glyph: GlyphName,
) =>
  entry(
    { id: `windows-${layout}`, glyph, hides: true, run: { kind: "place", layout } },
    `windows.${layout}`,
  );

const WINDOWS: readonly ActionNode[] = [
  windowPart("left", "left"),
  windowPart("right", "right"),
  windowPart("top", "top"),
  windowPart("bottom", "bottom"),
  windowPart("maximize", "full"),
  windowPart("center", "center"),
];

/** Famille de couleur des raccourcis et des commandes d'une roue personnalisée. */
const CUSTOM_ID = "action-custom";

/** Toutes les parts de la roue Actions, dans leur ordre d'origine. */
export function actionCatalog(config: Pick<WheelConfig, "windowLayout">): ActionNode[] {
  const tree: ActionNode[] = [
    entry(
      {
        id: "action-capture",
        glyph: "capture",
        color: BLUE,
        hides: true,
        run: { kind: "capture", target: "zone", delay: 0 },
        children: CAPTURE,
      },
      "group.capture",
      { hint: () => t("wheel.actions.group.capture.hint") },
    ),
    entry(
      { id: "action-text", glyph: "text", color: GREEN, hides: true, run: { kind: "text" } },
      "group.text",
    ),
    entry(
      {
        id: "action-color",
        glyph: "color",
        color: PINK,
        hides: true,
        run: { kind: "color", format: "hex" },
        children: COLOR,
      },
      "group.color",
      { hint: () => t("wheel.actions.group.color.hint") },
    ),
    entry({ id: "action-files", glyph: "files", color: ORANGE, children: FILES }, "group.files"),
    entry({ id: "action-image", glyph: "image", color: VIOLET, children: IMAGE }, "group.image"),
    entry({ id: "action-video", glyph: "video", color: RED, children: VIDEO }, "group.video"),
  ];
  if (config.windowLayout) {
    tree.push(
      entry(
        { id: "action-windows", glyph: "grid", color: SLATE, children: WINDOWS },
        "group.windows",
      ),
    );
  }
  tree.push(entry({ id: "action-apps", glyph: "star", color: TEAL, goesTo: "apps" }, "group.apps"));
  return tree;
}

/** Une part d'une liste réglable, et si elle est affichée. */
export interface Arranged<T> {
  item: T;
  enabled: boolean;
}

/** Parts dans l'ordre des réglages. Celles que les réglages ne connaissent pas encore (une
 * nouvelle version en ajoute) suivent dans leur ordre d'origine, à leur place par défaut. */
export function arrange<T extends { id: string; offByDefault?: boolean }>(
  catalog: readonly T[],
  entries: readonly PartEntry[],
): Arranged<T>[] {
  const known = entries.flatMap(({ id, enabled }) => {
    const item = catalog.find((part) => part.id === id);
    return item ? [{ item, enabled }] : [];
  });
  const added = catalog
    .filter((part) => !entries.some((entry) => entry.id === part.id))
    .map((item) => ({ item, enabled: !item.offByDefault }));
  return [...known, ...added];
}

/** Ce qu'enregistrent les réglages pour une liste réordonnée. */
export const partEntries = (parts: readonly Arranged<{ id: string }>[]): PartEntry[] =>
  parts.map(({ item, enabled }) => ({ id: item.id, enabled }));

/** Parts de la roue Actions, dans le sens horaire depuis le haut. */
export function actionTree(
  config: Pick<WheelConfig, "windowLayout"> & Partial<Pick<WheelConfig, "actionParts">>,
): ActionNode[] {
  return arrange(actionCatalog(config), config.actionParts ?? [])
    .filter(({ enabled }) => enabled)
    .map(({ item }) => item);
}

/** Actions proposées pour chaque type de fichier, dans leur ordre d'origine. */
export const FILE_ACTIONS: Record<FileKind, readonly ActionNode[]> = {
  images: [
    IMAGE.find(({ id }) => id === "image-compress")!,
    IMAGE.find(({ id }) => id === "image-half")!,
    IMAGE.find(({ id }) => id === "image-fullHd")!,
    IMAGE_TEXT,
    IMAGE_COPY,
    IMAGES_PDF,
    IMAGE.find(({ id }) => id === "image-strip")!,
    ZIP,
    RENAME_NODE,
    extend(PATHS, { offByDefault: true }),
  ],
  videos: [...VIDEO, ZIP, RENAME_NODE, extend(PATHS, { offByDefault: true })],
  pdfs: [MERGE, PDF_TEXT, ZIP, RENAME_NODE, PATHS],
  archives: [EXTRACT, RENAME_NODE, PATHS],
  others: [ZIP, RENAME_NODE, PATHS],
};

/** Comme les réglages par défaut côté Rust : images et vidéos au convertisseur d'abord. */
export const DEFAULT_FILE_WHEELS: FileWheels = {
  images: { first: "convert", parts: [] },
  videos: { first: "convert", parts: [] },
  pdfs: { first: "actions", parts: [] },
  archives: { first: "actions", parts: [] },
  others: { first: "actions", parts: [] },
};

/** Noms des types de fichiers : des accesseurs, lus dans la langue en cours à chaque usage. */
export const FILE_KIND_LABELS: Record<FileKind, string> = {
  get images() {
    return t("wheel.fileKind.images");
  },
  get videos() {
    return t("wheel.fileKind.videos");
  },
  get pdfs() {
    return t("wheel.fileKind.pdfs");
  },
  get archives() {
    return t("wheel.fileKind.archives");
  },
  get others() {
    return t("wheel.fileKind.others");
  },
};

const extension = (file: FileInfo) => file.name.split(".").pop()?.toLowerCase() ?? "";
const isArchive = (file: FileInfo) => extension(file) === "zip";

/** Type commun des fichiers ; un mélange compte comme `others`. */
export function fileKind(files: readonly FileInfo[]): FileKind {
  if (files.every((file) => file.video !== null)) return "videos";
  if (files.every((file) => file.format !== null)) return "images";
  if (files.every(isPdf)) return "pdfs";
  if (files.every(isArchive)) return "archives";
  return "others";
}

/** Roue à ouvrir d'abord pour ces fichiers, `null` pour rester sur la roue d'ouverture. */
export function firstModeFor(
  files: readonly FileInfo[],
  fileWheels: FileWheels,
  modes: readonly Mode[],
): Mode | null {
  if (files.length === 0) return null;
  const kind = fileKind(files);
  const mode: Mode | null = (() => {
    switch (fileWheels[kind]?.first ?? "usual") {
      case "convert":
        return kind === "images" ? "image" : kind === "videos" ? "video" : null;
      case "actions":
        return "actions";
      case "share":
        return "share";
      case "apps":
        return "apps";
      case "usual":
        return null;
    }
  })();
  return mode && modes.includes(mode) ? mode : null;
}

/** Roue personnalisée proposée pour ces fichiers : sans extension, elle va à tous. */
export const customSuits = (
  wheel: Pick<CustomWheelView, "extensions">,
  files: readonly FileInfo[],
) =>
  wheel.extensions.length === 0 ||
  files.every((file) => wheel.extensions.includes(extension(file)));

/** L'action a-t-elle de quoi travailler parmi ces fichiers ? */
function applies(node: ActionNode, files: readonly FileInfo[]): boolean {
  if (!node.needs || node.takesFiles) return true;
  const count = filesFor(node, files).length;
  return count >= (node.least ?? 1) && count <= (node.most ?? Infinity);
}

/** Roue Actions des fichiers glissés, déposés ou sélectionnés : seulement ce qui leur
 * convient, dans l'ordre des réglages. Sans rien d'utilisable, la roue Actions habituelle. */
export function fileTree(
  config: Pick<WheelConfig, "windowLayout" | "fileWheels"> &
    Partial<Pick<WheelConfig, "actionParts">>,
  files: readonly FileInfo[],
): ActionNode[] {
  const kind = fileKind(files);
  const nodes = arrange(FILE_ACTIONS[kind], config.fileWheels?.[kind]?.parts ?? [])
    .filter(({ enabled, item }) => enabled && applies(item, files))
    .map(({ item }) => item)
    .slice(0, MAX_SECTORS);
  return nodes.length > 0 ? nodes : actionTree(config);
}

/** Les actions d'un arbre et de ses sous-roues, à plat. */
function descendants(nodes: readonly ActionNode[] = []): ActionNode[] {
  return nodes.flatMap((node) => [node, ...descendants(node.children)]);
}

/** Actions qu'on peut poser sur une roue personnalisée, rangées par part de la roue Actions :
 * la part entière d'abord (elle garde sa sous-roue), puis chacune de ses actions, avec celles
 * que la roue Actions ne propose que pour un fichier. Chacune porte la couleur de sa part. */
export function actionChoices(
  config: Pick<WheelConfig, "windowLayout">,
): { group: ActionNode; actions: ActionNode[] }[] {
  const extras = Object.values(FILE_ACTIONS).flat();
  return actionCatalog(config)
    .filter((group) => !group.goesTo)
    .map((group) => {
      const family = group.family ?? group.id;
      const known = [group, ...descendants(group.children)];
      const added = extras.filter(
        (extra) => extra.family === family && !known.some((node) => node.id === extra.id),
      );
      const unique = [...known, ...added].filter(
        (node, index, all) => all.findIndex((other) => other.id === node.id) === index,
      );
      return {
        group,
        actions: unique.map((node) => ({ ...node, family, color: node.color ?? group.color })),
      };
    });
}

/** Ce que devient une part d'une roue personnalisée sur la roue ; `null` si elle ne
 * correspond à rien de connu (un format ou une action d'une autre version). */
function partNode(
  part: CustomPartView,
  wheel: number,
  slot: number,
  actions: readonly ActionNode[],
): ActionNode | null {
  const node = basePartNode(part, wheel, slot, actions);
  // Une couleur choisie pour la part passe avant celle de son format ou de son action, et
  // ses options en héritent
  return node && part.color ? { ...node, color: part.color, family: undefined } : node;
}

function basePartNode(
  part: CustomPartView,
  wheel: number,
  slot: number,
  actions: readonly ActionNode[],
): ActionNode | null {
  const id = `custom-${wheel}-${slot}`;
  const run: ActionRequest = { kind: "custom", wheel, action: slot };
  switch (part.kind) {
    case "app":
      return {
        id,
        label: part.name,
        action: t("wheel.open", { name: part.name }),
        dragAction: t("wheel.openWith", { name: part.name }),
        // Sans icône lisible, la part garde une pastille
        ...(part.icon ? { icon: part.icon } : { glyph: "grid" as const, color: SLATE }),
        opens: true,
        takesFiles: true,
        run,
      };
    case "folder":
      return {
        id,
        label: part.name,
        action: t("wheel.open", { name: part.name }),
        ...(part.icon ? { icon: part.icon } : { glyph: "files" as const, color: BLUE }),
        opens: true,
        run,
      };
    case "url":
      return {
        id,
        label: part.name,
        action: t("wheel.open", { name: part.name }),
        icon: part.icon ?? WEB_ICON,
        opens: true,
        run,
      };
    case "convert": {
      const image = OUTPUT_FORMATS.find((format) => format.id === part.value);
      if (image) {
        return {
          id,
          label: image.label,
          action: t("wheel.convertTo", { format: image.label }),
          color: image.color,
          family: image.id,
          needs: "images",
          convertImage: image.id,
        };
      }
      const video = VIDEO_FORMATS.find((format) => format.id === part.value);
      if (!video) return null;
      return {
        id,
        label: video.label,
        action: "action" in video ? video.action : t("wheel.convertTo", { format: video.label }),
        color: video.color,
        family: video.id,
        needs: "videos",
        convert: video.id,
      };
    }
    case "action": {
      const node = actions.find((action) => action.id === part.value);
      return node ? { ...node, id } : null;
    }
    case "shortcut":
    case "command":
      return {
        id,
        label: part.name,
        action: part.name,
        glyph: part.kind === "command" ? "terminal" : "play",
        color: YELLOW,
        family: CUSTOM_ID,
        hides: part.kind === "shortcut",
        takesFiles: true,
        run,
      };
  }
}

/** Parts de la roue personnalisée `index`, dans le sens horaire depuis le haut. */
export function customTree(
  config: Pick<WheelConfig, "custom" | "windowLayout">,
  index: number,
): ActionNode[] {
  const wheel = config.custom[index];
  if (!wheel) return [];
  const actions = actionChoices(config).flatMap((choice) => choice.actions);
  return wheel.parts.slice(0, MAX_SECTORS).flatMap((part, slot) => {
    const node = partNode(part, index, slot, actions);
    return node ? [node] : [];
  });
}

/** Roues entre lesquelles passer avec ces fichiers. Une roue personnalisée limitée à des
 * extensions ne s'affiche que pour eux, et jamais sans part. */
export function wheelModes(
  config: Pick<WheelConfig, "modes" | "custom" | "windowLayout">,
  files: readonly FileInfo[],
): Mode[] {
  return config.modes.filter((mode) => {
    if (!isCustomMode(mode)) return true;
    const index = customIndex(mode, config.custom);
    const wheel = config.custom[index];
    return (
      wheel !== undefined &&
      (files.length === 0 || customSuits(wheel, files)) &&
      customTree(config, index).length > 0
    );
  });
}

/** Couleurs choisies dans les réglages, et celle de la part de départ sur ses sous-roues. */
export function colorizeActions(
  nodes: readonly ActionNode[],
  colors: Readonly<Record<string, string>>,
  inherited?: string,
): ActionNode[] {
  return nodes.map((node) => {
    const family = node.family !== undefined ? colors[node.family] : undefined;
    const color = colors[node.id] ?? family ?? inherited ?? node.color;
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
    case "archives":
      return isArchive(file);
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

/** Tous les fichiers sont déjà dans le format de la conversion : elle n'aurait pas de sens. */
function alreadyConverted(node: ActionNode, files: readonly FileInfo[]): boolean {
  if (node.convertImage) return files.every((file) => file.format === node.convertImage);
  if (node.convert) return files.every((file) => file.video === node.convert);
  return false;
}

/** Parts grisées : celles dont aucun des fichiers connus ne convient. */
export function disabledActions(
  nodes: readonly ActionNode[],
  files: readonly FileInfo[],
): Set<string> {
  if (files.length === 0) return new Set();
  return new Set(
    nodes
      .filter((node) => {
        if (!node.needs) return false;
        const suited = filesFor(node, files);
        return suited.length === 0 || alreadyConverted(node, suited);
      })
      .map((node) => node.id),
  );
}

/** Une sous-roue s'ouvre en restant sur la part. */
export const opensOnDwell = (node: ActionNode | undefined): boolean => node?.children !== undefined;
