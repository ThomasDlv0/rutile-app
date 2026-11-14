import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  WHEEL_CLOSE_EVENT,
  WHEEL_CONFIG_EVENT,
  WHEEL_DRAG_EVENT,
  WHEEL_FILES_EVENT,
  WHEEL_OPEN_EVENT,
  WHEEL_PROGRESS_EVENT,
  WHEEL_TOAST_EVENT,
  appBadges,
  convertFiles,
  convertVideos,
  hideToastWindow,
  hideWheel,
  inspectFiles,
  launchApp,
  openSettings,
  pickFiles,
  primaryButtonPressed,
  runAction,
  shareFiles,
  showToastWindow,
  videoSupport,
  wheelClosing,
  wheelConfig,
  wheelReady,
  type ActionRequest,
  type FileInfo,
  type ShareTarget,
  type Toast,
  type WheelConfig,
  type VideoSupport,
  type WheelDrag,
  type WheelFiles,
  type WheelOpened,
} from "../ipc";
import {
  type ActionNode,
  DEFAULT_FILE_WHEELS,
  actionParent,
  actionTree,
  actionsAt,
  colorizeActions,
  customTree,
  disabledActions,
  fileKind,
  fileTree,
  filesFor,
  firstModeFor,
  opensOnDwell,
  wheelModes,
} from "./actions";
import {
  ALL_MODES,
  type Mode,
  OUTPUT_FORMATS,
  VIDEO_FORMATS,
  type WheelItem,
  appItems,
  colorize,
  customIndex,
  formatsFor,
  isCustomMode,
  isTreeMode,
  shareItems,
} from "./formats";
import { WINDOW_SIZE, isInsideHub } from "./geometry";
import {
  type HubText,
  type Point,
  disabledFormats,
  hubFor,
  nextMode,
  preferredMode,
  usableSector,
} from "./selection";
import { type Phase, Wheel, type Work } from "./Wheel";

/** Sans état du bouton de la souris (Wayland), délai laissé pour amener un fichier. */
const UNKNOWN_BUTTON_GRACE_MS = 3000;
/** Le dépôt arrive juste après le relâchement du bouton. */
const DROP_SETTLE_MS = 250;
const BUTTON_POLL_MS = 40;
/** Ouverte par un secouage, la roue se ferme si aucun fichier n'arrive dans ce délai. */
const DROP_WAIT_MS = 3000;
/** Durées identiques aux animations de styles.css. */
const CLOSE_ANIMATION_MS = 120;
const RESULT_VISIBLE_MS = 450;
/** Durée d'une annonce à l'écran, puis de sa disparition, comme dans styles.css. */
const TOAST_VISIBLE_MS = 2600;
const TOAST_LEAVE_MS = 180;
/** Mouvement qui réarme l'ouverture d'une sous-roue au maintien. */
const DWELL_MOVE_PX = 14;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Indication du centre quand la roue attend un fichier secoué, selon la roue. */
function dropHint(mode: Mode): HubText | null {
  if (mode === "apps") return null;
  const target = isCustomMode(mode)
    ? "une part"
    : mode === "share"
      ? "un partage"
      : mode === "actions"
        ? "une action"
        : "un format";
  return { label: `Déposez sur ${target}`, tone: "muted" };
}

const ACTION_LABELS = { working: "En cours…", done: "Terminé" };
const CONVERT_LABELS = { working: "Conversion…", done: "Converti" };

const OPEN_LABELS = { working: "Ouverture…", done: "Ouvert" };
/** Un service ouvre sa fenêtre (choix de l'appareil, du destinataire) ; le reste copie. */
const SHARE_LABELS: Record<ShareTarget["kind"], Work["labels"]> = {
  service: OPEN_LABELS,
  folder: { working: "Copie…", done: "Copié" },
  app: { working: "Copie…", done: "Copié" },
  system: { working: "Choisissez…", done: "Partagé" },
};

// Aperçu dans un navigateur : toutes les roues, une roue personnalisée qui mélange tout, et
// quelques apps et partages sans icône
const PREVIEW_CONFIG: WheelConfig = {
  modes: [...ALL_MODES, "custom:demo"],
  remember: false,
  dwellMs: 1000,
  colors: {},
  highlight: null,
  border: "none",
  borderColor: null,
  glass: "css",
  windowLayout: true,
  custom: [
    {
      id: "demo",
      name: "Boulot",
      extensions: [],
      parts: [
        { name: "Finder", kind: "app", value: null, icon: null },
        { name: "YouTube", kind: "url", value: null, icon: null },
        { name: "", kind: "convert", value: "png", icon: null },
        { name: "", kind: "convert", value: "mp4", icon: null },
        { name: "", kind: "action", value: "action-capture", icon: null },
        { name: "", kind: "action", value: "image-compress", icon: null },
        { name: "Ranger", kind: "command", value: null, icon: null },
      ],
    },
  ],
  actionParts: [],
  fileWheels: DEFAULT_FILE_WHEELS,
  apps: ["Finder", "Signal", null, "Brave", "Items", "Claude"].map((name) =>
    name ? { path: name, name, kind: "app", icon: null } : null,
  ),
  share: [
    { kind: "service", id: "airdrop", name: "AirDrop", icon: null },
    { kind: "service", id: "messages", name: "Messages", icon: null },
    { kind: "app", path: "Signal", name: "Signal", icon: null },
    null,
    { kind: "folder", path: "Drive", name: "Google Drive", icon: null },
    { kind: "service", id: "mail", name: "Mail", icon: null },
  ],
};

/** Pastilles relues tant que la roue des apps reste affichée. */
const BADGE_REFRESH_MS = 3000;
const PREVIEW_BADGES = [null, "3", null, null, null, "12"];

function itemsFor(
  mode: Mode,
  config: WheelConfig,
  badges: readonly (string | null)[] = [],
): readonly WheelItem[] {
  if (mode === "apps") return appItems(config.apps, badges);
  if (mode === "share") return shareItems(config.share);
  // Les parts de la roue Actions et des roues personnalisées viennent de leur arbre
  if (mode === "actions" || isCustomMode(mode)) return [];
  return colorize(formatsFor(mode), config.colors);
}

/** Roue où mène un fichier glissé maintenu au centre : le partage depuis une autre roue, et
 * depuis le partage, le convertisseur du fichier (ou la roue d'avant). */
function dwellTargetFor(
  mode: Mode,
  files: FileInfo[],
  modes: readonly Mode[],
  beforeShare: Mode | null,
): Mode | null {
  if (mode !== "share") return modes.includes("share") ? "share" : null;
  const candidates: (Mode | null)[] = [preferredMode(files), beforeShare, "image", "video"];
  const usable = (candidate: Mode | null) =>
    candidate !== null && candidate !== "share" && modes.includes(candidate);
  return candidates.find(usable) ?? null;
}

// Hors de Tauri (aperçu dans un navigateur), `?file=photo.png` ou `?file=clip.mov` simule
// un fichier, `?file=a.pdf&file=b.pdf` plusieurs
function previewFiles(): FileInfo[] {
  return new URLSearchParams(window.location.search).getAll("file").map((name) => {
    const extension = name.split(".").pop()?.toLowerCase();
    const id = extension === "jpg" ? "jpeg" : extension;
    const format = OUTPUT_FORMATS.find((f) => f.id === id)?.id ?? null;
    const video = VIDEO_FORMATS.find((f) => f.id === id && f.id !== "gif" && f.id !== "mp3");
    return { path: name, name, format, video: (video?.id as FileInfo["video"]) ?? null };
  });
}

/** Échelle qui ramène la roue, dessinée pour WINDOW_SIZE pixels CSS, à la taille de sa
 * fenêtre. WebKitGTK agrandit les pages selon la mise à l'échelle du texte du système
 * (110 % sous Cinnamon, par exemple) : sans elle, la roue déborde et se fait couper. */
function useWindowFit(): number {
  const measure = () => {
    const side = Math.min(window.innerWidth, window.innerHeight);
    // Fenêtre pas encore dimensionnée, ou aperçu dans un navigateur : taille normale
    if (!isTauri() || side <= 0) return 1;
    const fit = side / WINDOW_SIZE;
    return Math.abs(fit - 1) < 0.01 ? 1 : Math.min(Math.max(fit, 0.5), 2);
  };
  const [fit, setFit] = useState(measure);
  useEffect(() => {
    const update = () => setFit(measure());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return fit;
}

export function WheelApp() {
  const fit = useWindowFit();
  const [phase, setPhase] = useState<Phase>("closed");
  const [openCount, setOpenCount] = useState(0);
  // Roues actives dans l'ordre du clic au centre, et apps de la roue des apps
  const [config, setConfig] = useState<WheelConfig>(PREVIEW_CONFIG);
  // Roue affichée : la première à l'ouverture, puis le clic au centre passe à la suivante
  const [mode, setMode] = useState<Mode>("image");
  // Fichiers connus sans glisser : sélection du Finder ou de l'Explorateur, `--open`, sélecteur
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [openMode, setOpenMode] = useState<WheelOpened["mode"]>("focus");
  // Fichiers en cours de glisser au-dessus de la roue
  const [dragFiles, setDragFiles] = useState<FileInfo[] | null>(null);
  // Souris ou fichier glissé, en pixels CSS de la roue
  const [pointer, setPointer] = useState<Point | null>(null);
  const [work, setWork] = useState<Work | null>(null);
  // Demandé à la première entrée en mode Vidéo
  const [video, setVideo] = useState<VideoSupport | null>(null);
  // Pastilles de notifications des apps, comme dans le Dock
  const [badges, setBadges] = useState<(string | null)[]>(isTauri() ? [] : PREVIEW_BADGES);

  const shown = dragFiles ?? files;
  // Roues entre lesquelles passer : une roue personnalisée limitée à certains fichiers ne
  // s'affiche que pour eux
  const modes = useMemo(() => wheelModes(config, shown), [config, shown]);
  // Sous-roues ouvertes dans la roue Actions ou une roue personnalisée : un index par niveau
  const [actionPath, setActionPath] = useState<number[]>([]);
  // Avec des fichiers, la roue Actions ne propose que ce qui leur convient
  const actionsTree = useMemo(
    () =>
      colorizeActions(
        shown.length > 0 ? fileTree(config, shown) : actionTree(config),
        config.colors,
      ),
    [config, shown],
  );
  const customAt = customIndex(mode, config.custom);
  const customNodes = useMemo(
    () => colorizeActions(customTree(config, customAt), config.colors),
    [config, customAt],
  );
  const tree = customAt >= 0 ? customNodes : actionsTree;
  const treeKind = shown.length > 0 ? fileKind(shown) : null;
  useEffect(() => setActionPath([]), [treeKind]);
  const inTree = isTreeMode(mode);
  const videoMissing = mode === "video" && video?.available === false;
  const items = inTree ? actionsAt(tree, actionPath) : itemsFor(mode, config, badges);
  const parent = inTree ? actionParent(tree, actionPath) : null;
  const next = parent ? null : nextMode(modes, mode);
  const customName = (wheel: Mode | null) =>
    wheel ? config.custom[customIndex(wheel, config.custom)]?.name : undefined;
  const disabled = useMemo(() => {
    if (inTree) return disabledActions(items as readonly ActionNode[], shown);
    return videoMissing
      ? new Set<string>(formatsFor("video").map((format) => format.id))
      : disabledFormats(shown, mode);
  }, [shown, mode, videoMissing, inTree, items]);
  const highlighted = work ? work.index : pointer && usableSector(...pointer, disabled, items);
  // Rester sur une part ouvre sa sous-roue. Après ouverture, il faut bouger un peu pour
  // recommencer : sinon une sous-roue en ouvrirait une autre, sous le pointeur resté immobile
  const dwellFrom = useRef<Point | null>(null);
  if (
    dwellFrom.current &&
    pointer &&
    Math.hypot(pointer[0] - dwellFrom.current[0], pointer[1] - dwellFrom.current[1]) >
      DWELL_MOVE_PX
  ) {
    dwellFrom.current = null;
  }
  const keyboardPointer = useRef(false);
  const dwellPart =
    inTree &&
    work === null &&
    highlighted !== null &&
    dwellFrom.current === null &&
    !keyboardPointer.current &&
    opensOnDwell(items[highlighted] as ActionNode)
      ? highlighted
      : null;
  // Fichier glissé maintenu au centre : bascule entre conversion et partage. Après une bascule,
  // il faut quitter le centre puis y revenir pour rebasculer
  const [dwellArmed, setDwellArmed] = useState(true);
  const beforeShareRef = useRef<Mode | null>(null);
  const inHub = pointer !== null && isInsideHub(...pointer);
  const dwellTarget =
    dragFiles !== null && dwellArmed
      ? dwellTargetFor(mode, dragFiles, modes, beforeShareRef.current)
      : null;
  const dwelling = dwellTarget !== null && work === null && inHub;
  const missingHint: HubText | null =
    videoMissing && video
      ? { label: "FFmpeg introuvable", tone: "muted", hint: video.installHint }
      : null;
  const hub =
    hubFor(
      pointer,
      disabled,
      shown,
      dragFiles !== null,
      mode,
      items,
      next,
      dwellTarget,
      parent !== null,
      customName(next),
    ) ??
    missingHint ??
    (parent ? { label: parent.label, tone: "muted", hint: "Retour au centre" } : null) ??
    (openMode === "drop" ? dropHint(mode) : null);

  // Les écouteurs Tauri sont branchés une fois : ils lisent l'état courant par ces références
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const configRef = useRef(config);
  configRef.current = config;
  const pointerRef = useRef(pointer);
  pointerRef.current = pointer;
  const modesRef = useRef(modes);
  modesRef.current = modes;
  const actionNodesRef = useRef<readonly ActionNode[]>([]);
  actionNodesRef.current = inTree ? (items as readonly ActionNode[]) : actionsTree;
  const busyRef = useRef(false);
  const dragOverRef = useRef(false);
  const focusedRef = useRef(false);
  const blurCheck = useRef(0);
  const dropCount = useRef(0);
  const openId = useRef(0);
  const pickingRef = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);
  // Roue choisie par l'utilisateur depuis l'ouverture (clic ou maintien au centre) : les
  // fichiers ne la changent plus
  const chosenRef = useRef(false);

  /** Les fichiers ouvrent la roue réglée pour leur type (le convertisseur pour une image ou
   * une vidéo, la roue Actions pour le reste), quelle que soit la roue d'ouverture ; une roue
   * choisie à la main reste affichée. */
  const adoptMode = useCallback((infos: FileInfo[]): Mode => {
    const current = modeRef.current;
    const config = configRef.current;
    const usable = wheelModes(config, infos);
    const first = firstModeFor(infos, config.fileWheels, usable);
    let target = chosenRef.current || !first ? current : first;
    // Une roue personnalisée réservée à d'autres fichiers laisse la place à la première
    if (!usable.includes(target)) target = usable[0] ?? current;
    if (target === current) return current;
    modeRef.current = target;
    setMode(target);
    return target;
  }, []);

  /** Clic au centre, ou fichier maintenu au centre : la roue est choisie à la main. */
  const chooseMode = useCallback((chosen: Mode) => {
    chosenRef.current = true;
    modeRef.current = chosen;
    setMode(chosen);
    setActionPath([]);
  }, []);

  /** Ouvre la sous-roue de la part `index`. */
  const openChildren = useCallback((index: number) => {
    chosenRef.current = true;
    dwellFrom.current = pointerRef.current;
    setActionPath((path) => [...path, index]);
  }, []);

  const goBack = useCallback(() => {
    dwellFrom.current = pointerRef.current;
    setActionPath((path) => path.slice(0, -1));
  }, []);

  useEffect(() => {
    if (dwellPart === null) return;
    const timer = window.setTimeout(() => openChildren(dwellPart), config.dwellMs);
    return () => window.clearTimeout(timer);
  }, [dwellPart, config.dwellMs, openChildren]);

  useEffect(() => {
    if (!inHub) setDwellArmed(true);
  }, [inHub]);

  // Quitter le centre avant la fin annule : le minuteur est défait avec `dwelling`
  useEffect(() => {
    if (!dwelling || !dwellTarget) return;
    const timer = window.setTimeout(() => {
      if (dwellTarget === "share") beforeShareRef.current = modeRef.current;
      setDwellArmed(false);
      chooseMode(dwellTarget);
    }, config.dwellMs);
    return () => window.clearTimeout(timer);
  }, [dwelling, dwellTarget, config.dwellMs, chooseMode]);

  const applyConfig = useCallback((next: WheelConfig) => {
    configRef.current = next;
    setConfig(next);
    if (!next.modes.includes(modeRef.current)) setMode(next.modes[0] ?? "image");
  }, []);

  useEffect(() => {
    if (mode === "video" && video === null && isTauri()) void videoSupport().then(setVideo);
  }, [mode, video]);

  // Résultat d'une action, affiché une fois la roue fermée
  const [toast, setToast] = useState<Toast | null>(null);
  const [toastLeaving, setToastLeaving] = useState(false);
  const toastTimers = useRef<number[]>([]);
  const pendingToast = useRef<Toast | null>(null);

  const clearToast = useCallback(() => {
    toastTimers.current.forEach((timer) => window.clearTimeout(timer));
    toastTimers.current = [];
    pendingToast.current = null;
    setToast(null);
    setToastLeaving(false);
  }, []);

  const showToast = useCallback(
    (next: Toast) => {
      clearToast();
      setToast(next);
      void showToastWindow();
      toastTimers.current = [
        window.setTimeout(() => setToastLeaving(true), TOAST_VISIBLE_MS),
        window.setTimeout(() => {
          clearToast();
          void hideToastWindow();
        }, TOAST_VISIBLE_MS + TOAST_LEAVE_MS),
      ];
    },
    [clearToast],
  );

  const close = useCallback(() => {
    if (phaseRef.current !== "open") return;
    phaseRef.current = "closing";
    setPhase("closing");
    if (isTauri()) void wheelClosing();
    closeTimer.current = window.setTimeout(() => {
      setPhase("closed");
      setPointer(null);
      setDragFiles(null);
      setWork(null);
      if (isTauri()) {
        setFiles([]);
        const waiting = pendingToast.current;
        pendingToast.current = null;
        void hideWheel().then(() => waiting && showToast(waiting));
      } else {
        // Aperçu navigateur : la roue se rouvre pour continuer à la régler
        window.setTimeout(() => {
          phaseRef.current = "open";
          setOpenCount((count) => count + 1);
          setPhase("open");
        }, 400);
      }
    }, CLOSE_ANIMATION_MS);
  }, [showToast]);

  const convert = useCallback(
    async (targets: FileInfo[], index: number, targetMode: Mode) => {
      if (targets.length === 0 || busyRef.current) return;
      // Une vidéo peut durer : si la roue est refermée puis rouverte entre-temps, le résultat
      // de cette conversion ne concerne plus la nouvelle roue
      const id = openId.current;
      busyRef.current = true;
      setWork({ index, state: "working", progress: targetMode === "video" ? 0 : undefined });
      const paths = targets.map((file) => file.path);
      let state: Work["state"] = "failed";
      try {
        const outcome =
          targetMode === "video"
            ? await convertVideos(paths, VIDEO_FORMATS[index].id)
            : await convertFiles(paths, OUTPUT_FORMATS[index].id);
        if (outcome.converted > 0) state = "done";
      } catch (error) {
        console.error("rutile : conversion interrompue", error);
      }
      if (openId.current !== id) return;
      // Bref retour visuel ; le détail est dans la notification
      setWork({ index, state });
      await sleep(RESULT_VISIBLE_MS);
      busyRef.current = false;
      close();
    },
    [close],
  );

  /** Action rapide depuis la part `index` (ouvrir une app, partager) : son issue s'affiche
   * brièvement au centre, puis la roue se ferme. */
  const perform = useCallback(
    async (
      index: number,
      labels: Work["labels"],
      action: () => Promise<unknown>,
      progress?: number,
    ) => {
      if (busyRef.current) return;
      const id = openId.current;
      busyRef.current = true;
      setWork({ index, state: "working", labels, progress });
      let state: Work["state"] = "failed";
      try {
        await action();
        state = "done";
      } catch (error) {
        console.error("rutile : action impossible", error);
      }
      if (openId.current !== id) return;
      setWork({ index, state, labels });
      await sleep(RESULT_VISIBLE_MS);
      busyRef.current = false;
      close();
    },
    [close],
  );

  /** Lance l'app d'une part, en lui faisant ouvrir les fichiers déposés. Une part vide
   * ouvre les réglages pour en choisir une. */
  const openApp = useCallback(
    async (index: number, paths: string[]) => {
      if (busyRef.current) return;
      if (!configRef.current.apps[index]) {
        void openSettings("apps");
        close();
        return;
      }
      await perform(index, OPEN_LABELS, () => launchApp(index, paths));
    },
    [close, perform],
  );

  /** Partage les fichiers avec la destination d'une part. Une part vide ouvre les réglages
   * pour en choisir une. */
  const shareTo = useCallback(
    async (index: number, paths: string[]) => {
      if (busyRef.current) return;
      const target = configRef.current.share[index];
      if (!target) {
        void openSettings("share");
        close();
        return;
      }
      await perform(index, SHARE_LABELS[target.kind], () => shareFiles(index, paths));
    },
    [close, perform],
  );

  /** Clic ou dépôt sur une part de la roue Actions. */
  const runNode = useCallback(
    async (node: ActionNode, index: number, known: FileInfo[]) => {
      if (busyRef.current) return;
      if (node.goesTo) {
        chooseMode(node.goesTo);
        return;
      }
      const { run, convert: conversion, convertImage } = node;
      if (!run && !conversion && !convertImage) {
        if (node.children) openChildren(index);
        return;
      }
      if (node.hides && run) {
        // Rien de la roue ne doit rester à l'écran : elle serait capturée, ou gênerait
        close();
        await sleep(CLOSE_ANIMATION_MS + 60);
        const paths = filesFor(node, known).map((file) => file.path);
        await runAction(run, paths).catch((error) => console.error("rutile : action", error));
        return;
      }
      let targets = filesFor(node, known);
      if (node.needs && targets.length === 0) {
        if (pickingRef.current) return;
        pickingRef.current = true;
        try {
          targets = filesFor(node, await pickFiles(node.needs));
        } finally {
          pickingRef.current = false;
        }
        if (targets.length === 0) return;
      }
      const paths = targets.map((file) => file.path);
      const isVideo = node.needs === "videos";
      // Une conversion qui n'a rien converti est un échec, comme sur les roues de conversion
      const converted = async (outcome: Promise<{ converted: number }>) => {
        if ((await outcome).converted === 0) throw new Error("aucun fichier converti");
      };
      await perform(
        index,
        conversion || convertImage ? CONVERT_LABELS : node.opens ? OPEN_LABELS : ACTION_LABELS,
        () =>
          conversion
            ? converted(convertVideos(paths, conversion))
            : convertImage
              ? converted(convertFiles(paths, convertImage))
              : runAction(run as ActionRequest, paths),
        isVideo ? 0 : undefined,
      );
    },
    [chooseMode, openChildren, perform, close],
  );

  const drop = useCallback(
    async (paths: string[], x: number, y: number) => {
      dropCount.current++;
      // Réservé tout de suite : la perte de focus ne doit pas fermer la roue entre-temps
      busyRef.current = true;
      const dropped = await inspectFiles(paths);
      busyRef.current = false;
      setDragFiles(null);
      // Gardés : la roue Actions des fichiers reste affichée, et une sous-roue ouverte par le
      // dépôt (Renommer) travaille sur eux
      setFiles(dropped);
      setPointer(null);
      const dropMode = adoptMode(dropped);
      if (dropMode === "actions" || isCustomMode(dropMode)) {
        const nodes = actionNodesRef.current;
        const index = usableSector(x, y, disabledActions(nodes, dropped), nodes);
        if (index === null) close();
        else await runNode(nodes[index], index, dropped);
        return;
      }
      if (dropMode === "apps" || dropMode === "share") {
        const config = configRef.current;
        const index = usableSector(x, y, new Set(), itemsFor(dropMode, config));
        const filled = index !== null && (dropMode === "apps" ? config.apps : config.share)[index];
        // Lâché sur une part vide : rien à faire, les réglages s'ouvrent au clic seulement
        if (index === null || !filled) close();
        else if (dropMode === "apps") await openApp(index, paths);
        else await shareTo(index, paths);
        return;
      }
      const dropItems = formatsFor(dropMode);
      const index = usableSector(x, y, disabledFormats(dropped, dropMode), dropItems);
      // Lâché au centre, sur un format grisé ou hors du disque : rien à faire
      if (index === null) close();
      else await convert(dropped, index, dropMode);
    },
    [adoptMode, close, convert, openApp, runNode, shareTo],
  );

  /** Clic sur une part : lance l'app, convertit ou partage les fichiers connus, ou les fait
   * choisir d'abord. */
  const select = useCallback(
    async (index: number) => {
      // En pleine fermeture, les fichiers sont déjà oubliés : le clic ouvrirait le sélecteur
      if (phaseRef.current !== "open") return;
      if (mode === "apps") {
        await openApp(index, []);
        return;
      }
      if (mode === "actions" || isCustomMode(mode)) {
        await runNode(actionNodesRef.current[index], index, files);
        return;
      }
      const sharing = mode === "share";
      // Une part de partage vide ouvre les réglages, sans demander de fichier
      if (sharing && !configRef.current.share[index]) {
        await shareTo(index, []);
        return;
      }
      const run = (targets: FileInfo[]) =>
        sharing
          ? shareTo(
              index,
              targets.map((file) => file.path),
            )
          : convert(targets, index, mode);
      if (files.length > 0) {
        await run(files);
        return;
      }
      if (pickingRef.current || busyRef.current) return;
      // Le sélecteur prend le clavier : la roue ne doit pas se fermer pour autant
      pickingRef.current = true;
      try {
        const picked = await pickFiles(sharing ? "any" : mode === "video" ? "videos" : "images");
        if (picked.length > 0) {
          setFiles(picked);
          await run(picked);
        }
      } finally {
        pickingRef.current = false;
      }
    },
    [convert, files, mode, openApp, runNode, shareTo],
  );

  // Ouverte par un secouage : la roue attend le fichier, et se ferme s'il est lâché ailleurs
  // ou s'il n'arrive pas dans les 3 secondes
  const watchDrop = useCallback(
    async (id: number) => {
      const drops = dropCount.current;
      let deadline = Date.now() + DROP_WAIT_MS;
      while (openId.current === id && phaseRef.current === "open") {
        if (busyRef.current || dropCount.current !== drops) return;
        if (dragOverRef.current) deadline = Date.now() + DROP_WAIT_MS;
        if ((await primaryButtonPressed()) === false) {
          await sleep(DROP_SETTLE_MS);
          const dropped = busyRef.current || dropCount.current !== drops;
          if (!dropped && openId.current === id) close();
          return;
        }
        if (Date.now() > deadline) {
          close();
          return;
        }
        await sleep(BUTTON_POLL_MS);
      }
    },
    [close],
  );

  // Un clic à l'extérieur peut aussi commencer un glisser vers la roue : on attend le relâchement
  const closeUnlessDragging = useCallback(async () => {
    const check = ++blurCheck.current;
    const drops = dropCount.current;
    for (;;) {
      const pressed = await primaryButtonPressed();
      if (pressed === null) {
        await sleep(UNKNOWN_BUTTON_GRACE_MS);
        break;
      }
      if (!pressed) break;
      await sleep(BUTTON_POLL_MS);
      if (check !== blurCheck.current) return;
    }
    await sleep(DROP_SETTLE_MS);
    const stillAway =
      !focusedRef.current && !dragOverRef.current && !busyRef.current && !pickingRef.current;
    const dropped = dropCount.current !== drops;
    if (check === blurCheck.current && stillAway && !dropped) close();
  }, [close]);

  useEffect(() => {
    if (!isTauri()) {
      const preview = previewFiles();
      setFiles(preview);
      adoptMode(preview);
      setPhase("open");
      return;
    }

    const cleanups: Array<() => void> = [];
    let cancelled = false;
    // Un écouteur qui arrive après le démontage est retiré aussitôt
    const keep = (unlisten: () => void) => (cancelled ? unlisten() : cleanups.push(unlisten));
    (async () => {
      keep(
        await listen<WheelOpened>(WHEEL_OPEN_EVENT, ({ payload }) => {
          window.clearTimeout(closeTimer.current);
          clearToast();
          openId.current = payload.id;
          // Une conversion encore en cours appartient à l'ouverture précédente
          busyRef.current = false;
          chosenRef.current = false;
          beforeShareRef.current = null;
          // Dernière roue affichée si le réglage le demande, sinon la première de la liste
          const { remember } = configRef.current;
          const usable = wheelModes(configRef.current, []);
          const opening =
            remember && usable.includes(modeRef.current) ? modeRef.current : (usable[0] ?? "image");
          modeRef.current = opening;
          setMode(opening);
          setOpenMode(payload.mode);
          setFiles([]);
          setPointer(null);
          setActionPath([]);
          dwellFrom.current = null;
          setWork(null);
          setOpenCount((count) => count + 1);
          phaseRef.current = "open";
          setPhase("open");
          if (payload.mode === "drop") void watchDrop(payload.id);
        }),
      );
      keep(await listen(WHEEL_CLOSE_EVENT, close));
      keep(
        await listen<Toast>(WHEEL_TOAST_EVENT, ({ payload }) => {
          // Roue encore ouverte (résultat au centre, puis fermeture) : l'annonce suit
          if (phaseRef.current === "closed") showToast(payload);
          else pendingToast.current = payload;
        }),
      );
      keep(await listen<WheelConfig>(WHEEL_CONFIG_EVENT, ({ payload }) => applyConfig(payload)));
      applyConfig(await wheelConfig());
      keep(
        await listen<WheelFiles>(WHEEL_FILES_EVENT, ({ payload }) => {
          // Une sélection lue après une nouvelle ouverture n'a plus lieu d'être
          if (payload.id !== openId.current) return;
          setFiles(payload.files);
          adoptMode(payload.files);
        }),
      );
      keep(
        await listen<number>(WHEEL_PROGRESS_EVENT, ({ payload }) => {
          setWork((current) =>
            current?.state === "working" ? { ...current, progress: payload } : current,
          );
        }),
      );
      keep(
        await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          focusedRef.current = focused;
          blurCheck.current++;
          if (!focused && phaseRef.current === "open") void closeUnlessDragging();
        }),
      );
      keep(
        await listen<WheelDrag>(WHEEL_DRAG_EVENT, ({ payload }) => {
          if (busyRef.current) return;
          switch (payload.type) {
            case "enter":
              dragOverRef.current = true;
              setPointer([payload.x, payload.y]);
              void inspectFiles(payload.paths).then((infos) => {
                if (!dragOverRef.current) return;
                setDragFiles(infos);
                // Une vidéo glissée retourne la roue en mode Vidéo pendant le glisser
                adoptMode(infos);
              });
              break;
            case "over":
              setPointer([payload.x, payload.y]);
              break;
            case "drop":
              dragOverRef.current = false;
              void drop(payload.paths, payload.x, payload.y);
              break;
            case "leave":
              dragOverRef.current = false;
              setDragFiles(null);
              setPointer(null);
              break;
          }
        }),
      );
      if (!cancelled) await wheelReady();
    })();
    return () => {
      cancelled = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [adoptMode, applyConfig, clearToast, close, closeUnlessDragging, drop, showToast, watchDrop]);

  // Relues à l'ouverture de la roue des apps, puis régulièrement tant qu'elle est affichée
  useEffect(() => {
    if (!isTauri() || phase !== "open" || mode !== "apps") return;
    let active = true;
    const refresh = () =>
      void appBadges()
        .then((list) => active && setBadges(list))
        .catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, BADGE_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [phase, mode, openCount]);

  // Échap ferme, ou revient en arrière dans une sous-roue ; ↑ ↓ passent à la roue précédente
  // ou suivante, comme un clic au centre
  const inChildren = useRef(false);
  inChildren.current = parent !== null;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Backspace") {
        if (inChildren.current) goBack();
        else if (event.key === "Escape") close();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      if (busyRef.current || phaseRef.current !== "open" || inChildren.current) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      const target = nextMode(modesRef.current, modeRef.current, step);
      if (!target) return;
      setPointer(null);
      chooseMode(target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chooseMode, close, goBack]);

  const updatePointer = useCallback((point: Point | null, keyboard = false) => {
    keyboardPointer.current = keyboard;
    setPointer(point);
  }, []);

  const wheel = (
    <Wheel
      key={openCount}
      phase={phase}
      mode={mode}
      next={next}
      title={customName(mode)}
      nextTitle={customName(next)}
      items={items}
      disabled={disabled}
      highlighted={highlighted}
      hub={hub}
      work={work}
      onPointer={updatePointer}
      onSelect={(index) => void select(index)}
      onOutsideClick={close}
      dwelling={dwelling}
      dwellMs={config.dwellMs}
      dwellPart={dwellPart}
      back={parent !== null}
      accent={config.highlight}
      border={config.border}
      borderColor={config.borderColor ?? config.highlight}
      glass={config.glass}
      scale={fit}
      keyboard
      onToggleMode={() => (parent ? goBack() : next && chooseMode(next))}
    />
  );
  const notice = toast && (
    <div className="toast" data-ok={toast.ok} data-leaving={toastLeaving} role="status">
      <span className="toast-icon" aria-hidden="true">
        {toast.ok ? "✓" : "!"}
      </span>
      <span className="toast-text">
        <span className="toast-title">{toast.title}</span>
        {toast.body && <span className="toast-body">{toast.body}</span>}
      </span>
    </div>
  );
  if (fit === 1) {
    return (
      <>
        {wheel}
        {notice}
      </>
    );
  }
  // Les positions d'un glisser arrivent en pixels de la fenêtre, déjà ceux de la roue mise à
  // l'échelle : seuls les événements de la souris passent par `scale`
  return (
    <div style={{ transform: `scale(${fit})`, transformOrigin: "top left" }}>
      {wheel}
      {notice}
    </div>
  );
}
