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
  convertFiles,
  convertVideos,
  hideWheel,
  inspectFiles,
  launchApp,
  openSettings,
  pickFiles,
  primaryButtonPressed,
  shareFiles,
  videoSupport,
  wheelConfig,
  wheelReady,
  type FileInfo,
  type ShareTarget,
  type WheelConfig,
  type VideoSupport,
  type WheelDrag,
  type WheelFiles,
  type WheelOpened,
} from "../ipc";
import {
  ALL_MODES,
  type Mode,
  OUTPUT_FORMATS,
  VIDEO_FORMATS,
  type WheelItem,
  appItems,
  colorize,
  formatsFor,
  shareItems,
} from "./formats";
import { isInsideHub } from "./geometry";
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Indication du centre quand la roue attend un fichier secoué, selon la roue. */
const DROP_HINTS: Record<Mode, HubText | null> = {
  image: { label: "Déposez sur un format", tone: "muted" },
  video: { label: "Déposez sur un format", tone: "muted" },
  apps: null,
  share: { label: "Déposez sur un partage", tone: "muted" },
};

const OPEN_LABELS = { working: "Ouverture…", done: "Ouvert" };
/** Un service ouvre sa fenêtre (choix de l'appareil, du destinataire) ; le reste copie. */
const SHARE_LABELS: Record<ShareTarget["kind"], Work["labels"]> = {
  service: OPEN_LABELS,
  folder: { working: "Copie…", done: "Copié" },
  app: { working: "Copie…", done: "Copié" },
};

// Aperçu dans un navigateur : toutes les roues, et quelques apps et partages sans icône
const PREVIEW_CONFIG: WheelConfig = {
  modes: [...ALL_MODES],
  remember: false,
  dwellMs: 1000,
  colors: {},
  highlight: null,
  apps: ["Finder", "Signal", null, "Brave", "Items", "Claude"].map((name) =>
    name ? { path: name, name, icon: null } : null,
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

function itemsFor(mode: Mode, config: WheelConfig): readonly WheelItem[] {
  if (mode === "apps") return appItems(config.apps);
  if (mode === "share") return shareItems(config.share);
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
// un fichier
function previewFiles(): FileInfo[] {
  const name = new URLSearchParams(window.location.search).get("file");
  if (!name) return [];
  const extension = name.split(".").pop()?.toLowerCase();
  const id = extension === "jpg" ? "jpeg" : extension;
  const format = OUTPUT_FORMATS.find((f) => f.id === id)?.id ?? null;
  const video = VIDEO_FORMATS.find((f) => f.id === id && f.id !== "gif" && f.id !== "mp3");
  return [{ path: name, name, format, video: (video?.id as FileInfo["video"]) ?? null }];
}

export function WheelApp() {
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

  const videoMissing = mode === "video" && video?.available === false;
  const items = itemsFor(mode, config);
  const next = nextMode(config.modes, mode);
  const shown = dragFiles ?? files;
  const disabled = useMemo(
    () =>
      videoMissing
        ? new Set<string>(formatsFor("video").map((format) => format.id))
        : disabledFormats(shown, mode),
    [shown, mode, videoMissing],
  );
  const highlighted = work ? work.index : pointer && usableSector(...pointer, disabled, items);
  // Fichier glissé maintenu au centre : bascule entre conversion et partage. Après une bascule,
  // il faut quitter le centre puis y revenir pour rebasculer
  const [dwellArmed, setDwellArmed] = useState(true);
  const beforeShareRef = useRef<Mode | null>(null);
  const inHub = pointer !== null && isInsideHub(...pointer);
  const dwellTarget =
    dragFiles !== null && dwellArmed
      ? dwellTargetFor(mode, dragFiles, config.modes, beforeShareRef.current)
      : null;
  const dwelling = dwellTarget !== null && work === null && inHub;
  const missingHint: HubText | null =
    videoMissing && video
      ? { label: "FFmpeg introuvable", tone: "muted", hint: video.installHint }
      : null;
  const hub =
    hubFor(pointer, disabled, shown, dragFiles !== null, mode, items, next, dwellTarget) ??
    missingHint ??
    (openMode === "drop" ? DROP_HINTS[mode] : null);

  // Les écouteurs Tauri sont branchés une fois : ils lisent l'état courant par ces références
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const configRef = useRef(config);
  configRef.current = config;
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

  /** Une image ouvre le convertisseur d'images, une vidéo celui de vidéos, quelle que soit la
   * roue d'ouverture ; une roue choisie à la main reste affichée. */
  const adoptMode = useCallback((infos: FileInfo[]): Mode => {
    const current = modeRef.current;
    const preferred = preferredMode(infos);
    if (chosenRef.current || !preferred || !configRef.current.modes.includes(preferred)) {
      return current;
    }
    modeRef.current = preferred;
    setMode(preferred);
    return preferred;
  }, []);

  /** Clic au centre, ou fichier maintenu au centre : la roue est choisie à la main. */
  const chooseMode = useCallback((chosen: Mode) => {
    chosenRef.current = true;
    modeRef.current = chosen;
    setMode(chosen);
  }, []);

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
    if (!next.modes.includes(modeRef.current)) setMode(next.modes[0]);
  }, []);

  useEffect(() => {
    if (mode === "video" && video === null && isTauri()) void videoSupport().then(setVideo);
  }, [mode, video]);

  const close = useCallback(() => {
    if (phaseRef.current !== "open") return;
    phaseRef.current = "closing";
    setPhase("closing");
    closeTimer.current = window.setTimeout(() => {
      setPhase("closed");
      setPointer(null);
      setDragFiles(null);
      setWork(null);
      if (isTauri()) {
        setFiles([]);
        void hideWheel();
      } else {
        // Aperçu navigateur : la roue se rouvre pour continuer à la régler
        window.setTimeout(() => {
          phaseRef.current = "open";
          setOpenCount((count) => count + 1);
          setPhase("open");
        }, 400);
      }
    }, CLOSE_ANIMATION_MS);
  }, []);

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
    async (index: number, labels: Work["labels"], action: () => Promise<unknown>) => {
      if (busyRef.current) return;
      const id = openId.current;
      busyRef.current = true;
      setWork({ index, state: "working", labels });
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

  const drop = useCallback(
    async (paths: string[], x: number, y: number) => {
      dropCount.current++;
      // Réservé tout de suite : la perte de focus ne doit pas fermer la roue entre-temps
      busyRef.current = true;
      const dropped = await inspectFiles(paths);
      busyRef.current = false;
      setDragFiles(null);
      setPointer(null);
      const dropMode = adoptMode(dropped);
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
    [adoptMode, close, convert, openApp, shareTo],
  );

  /** Clic sur une part : lance l'app, convertit ou partage les fichiers connus, ou les fait
   * choisir d'abord. */
  const select = useCallback(
    async (index: number) => {
      if (mode === "apps") {
        await openApp(index, []);
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
    [convert, files, mode, openApp, shareTo],
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
          openId.current = payload.id;
          // Une conversion encore en cours appartient à l'ouverture précédente
          busyRef.current = false;
          chosenRef.current = false;
          beforeShareRef.current = null;
          // Dernière roue affichée si le réglage le demande, sinon la première de la liste
          const { modes, remember } = configRef.current;
          const opening = remember && modes.includes(modeRef.current) ? modeRef.current : modes[0];
          modeRef.current = opening;
          setMode(opening);
          setOpenMode(payload.mode);
          setFiles([]);
          setPointer(null);
          setWork(null);
          setOpenCount((count) => count + 1);
          phaseRef.current = "open";
          setPhase("open");
          if (payload.mode === "drop") void watchDrop(payload.id);
        }),
      );
      keep(await listen(WHEEL_CLOSE_EVENT, close));
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
  }, [adoptMode, applyConfig, close, closeUnlessDragging, drop, watchDrop]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return (
    <Wheel
      key={openCount}
      phase={phase}
      mode={mode}
      next={next}
      items={items}
      disabled={disabled}
      highlighted={highlighted}
      hub={hub}
      work={work}
      onPointer={setPointer}
      onSelect={(index) => void select(index)}
      onOutsideClick={close}
      dwelling={dwelling}
      dwellMs={config.dwellMs}
      accent={config.highlight}
      onToggleMode={() => next && chooseMode(next)}
    />
  );
}
