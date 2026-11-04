import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  WHEEL_CLOSE_EVENT,
  WHEEL_DRAG_EVENT,
  WHEEL_FILES_EVENT,
  WHEEL_OPEN_EVENT,
  WHEEL_PROGRESS_EVENT,
  convertFiles,
  convertVideos,
  hideWheel,
  inspectFiles,
  pickFiles,
  primaryButtonPressed,
  videoSupport,
  wheelReady,
  type FileInfo,
  type VideoSupport,
  type WheelDrag,
  type WheelFiles,
  type WheelOpened,
} from "../ipc";
import { type Mode, OUTPUT_FORMATS, VIDEO_FORMATS, formatsFor } from "./formats";
import {
  type HubText,
  type Point,
  disabledFormats,
  hubFor,
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

const DROP_HINT: HubText = { label: "Déposez sur un format", tone: "muted" };

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
  // Images ou vidéos : le clic au centre bascule, et les fichiers reçus le choisissent
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
  const shown = dragFiles ?? files;
  const disabled = useMemo(
    () =>
      videoMissing
        ? new Set<string>(formatsFor("video").map((format) => format.id))
        : disabledFormats(shown, mode),
    [shown, mode, videoMissing],
  );
  const highlighted = work ? work.index : pointer && usableSector(...pointer, disabled, mode);
  const missingHint: HubText | null =
    videoMissing && video
      ? { label: "FFmpeg introuvable", tone: "muted", hint: video.installHint }
      : null;
  const hub =
    hubFor(pointer, disabled, shown, dragFiles !== null, mode) ??
    missingHint ??
    (openMode === "drop" ? DROP_HINT : null);

  // Les écouteurs Tauri sont branchés une fois : ils lisent l'état courant par ces références
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const busyRef = useRef(false);
  const dragOverRef = useRef(false);
  const focusedRef = useRef(false);
  const blurCheck = useRef(0);
  const dropCount = useRef(0);
  const openId = useRef(0);
  const pickingRef = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);

  /** Les fichiers reçus choisissent le mode : vidéos d'un côté, images de l'autre. */
  const adoptMode = useCallback((infos: FileInfo[]) => {
    const preferred = preferredMode(infos);
    if (preferred) setMode(preferred);
    return preferred ?? modeRef.current;
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
      const index = usableSector(x, y, disabledFormats(dropped, dropMode), dropMode);
      // Lâché au centre, sur un format grisé ou hors du disque : rien à faire
      if (index === null) close();
      else await convert(dropped, index, dropMode);
    },
    [adoptMode, close, convert],
  );

  /** Clic sur une part : convertit les fichiers connus, ou les fait choisir d'abord. */
  const select = useCallback(
    async (index: number) => {
      if (files.length > 0) {
        await convert(files, index, mode);
        return;
      }
      if (pickingRef.current || busyRef.current) return;
      // Le sélecteur prend le clavier : la roue ne doit pas se fermer pour autant
      pickingRef.current = true;
      try {
        const picked = await pickFiles(mode === "video");
        if (picked.length > 0) {
          setFiles(picked);
          await convert(picked, index, mode);
        }
      } finally {
        pickingRef.current = false;
      }
    },
    [convert, files, mode],
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
  }, [adoptMode, close, closeUnlessDragging, drop, watchDrop]);

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
      disabled={disabled}
      highlighted={highlighted}
      hub={hub}
      work={work}
      onPointer={setPointer}
      onSelect={(index) => void select(index)}
      onOutsideClick={close}
      onToggleMode={() => setMode((current) => (current === "image" ? "video" : "image"))}
    />
  );
}
