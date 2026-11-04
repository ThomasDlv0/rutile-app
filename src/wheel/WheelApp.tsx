import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  WHEEL_CLOSE_EVENT,
  WHEEL_DRAG_EVENT,
  WHEEL_FILES_EVENT,
  WHEEL_OPEN_EVENT,
  convertFiles,
  hideWheel,
  inspectFiles,
  pickFiles,
  primaryButtonPressed,
  wheelReady,
  type FileInfo,
  type WheelDrag,
  type WheelFiles,
  type WheelOpened,
} from "../ipc";
import { OUTPUT_FORMATS } from "./formats";
import { type HubText, type Point, disabledFormats, hubFor, usableSector } from "./selection";
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

// Hors de Tauri (aperçu dans un navigateur), `?file=photo.png` simule un fichier
function previewFiles(): FileInfo[] {
  const name = new URLSearchParams(window.location.search).get("file");
  if (!name) return [];
  const extension = name.split(".").pop()?.toLowerCase();
  const id = extension === "jpg" ? "jpeg" : extension;
  const format = OUTPUT_FORMATS.find((f) => f.id === id)?.id ?? null;
  return [{ path: name, name, format }];
}

export function WheelApp() {
  const [phase, setPhase] = useState<Phase>("closed");
  const [openCount, setOpenCount] = useState(0);
  // Fichiers connus sans glisser : sélection du Finder ou de l'Explorateur, `--open`, sélecteur
  const [files, setFiles] = useState<FileInfo[]>([]);
  // La sélection est en cours de lecture : pas encore de bouton « Choisir… »
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [mode, setMode] = useState<WheelOpened["mode"]>("focus");
  // Fichiers en cours de glisser au-dessus de la roue
  const [dragFiles, setDragFiles] = useState<FileInfo[] | null>(null);
  // Souris ou fichier glissé, en pixels CSS de la roue
  const [pointer, setPointer] = useState<Point | null>(null);
  const [work, setWork] = useState<Work | null>(null);

  const shown = dragFiles ?? files;
  const disabled = useMemo(() => disabledFormats(shown), [shown]);
  const highlighted = work ? work.index : pointer && usableSector(...pointer, disabled);
  const dropHint = mode === "drop" ? DROP_HINT : null;
  const hub = hubFor(pointer, disabled, shown, dragFiles !== null) ?? dropHint;
  const canPick = mode === "focus" && shown.length === 0 && !loadingFiles && work === null;

  // Les écouteurs Tauri sont branchés une fois : ils lisent l'état courant par ces références
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const busyRef = useRef(false);
  const dragOverRef = useRef(false);
  const focusedRef = useRef(false);
  const blurCheck = useRef(0);
  const dropCount = useRef(0);
  const openId = useRef(0);
  const pickingRef = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);

  const close = useCallback(() => {
    if (phaseRef.current !== "open") return;
    phaseRef.current = "closing";
    setPhase("closing");
    closeTimer.current = window.setTimeout(() => {
      setPhase("closed");
      setPointer(null);
      setDragFiles(null);
      setWork(null);
      setLoadingFiles(false);
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
    async (targets: FileInfo[], index: number) => {
      if (targets.length === 0 || busyRef.current) return;
      busyRef.current = true;
      setWork({ index, state: "working" });
      let state: Work["state"] = "failed";
      try {
        const outcome = await convertFiles(
          targets.map((file) => file.path),
          OUTPUT_FORMATS[index].id,
        );
        if (outcome.converted > 0) state = "done";
      } catch (error) {
        console.error("rutile : conversion interrompue", error);
      }
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
      const index = usableSector(x, y, disabledFormats(dropped));
      // Lâché au centre, sur un format grisé ou hors du disque : rien à faire
      if (index === null) close();
      else await convert(dropped, index);
    },
    [close, convert],
  );

  const pick = useCallback(async () => {
    if (pickingRef.current || busyRef.current) return;
    // Le sélecteur prend le clavier : la roue ne doit pas se fermer pour autant
    pickingRef.current = true;
    try {
      const picked = await pickFiles();
      if (picked.length > 0) setFiles(picked);
    } finally {
      pickingRef.current = false;
    }
  }, []);

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
      setFiles(previewFiles());
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
          setMode(payload.mode);
          setFiles([]);
          setLoadingFiles(payload.loadingFiles);
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
          setLoadingFiles(false);
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
                if (dragOverRef.current) setDragFiles(infos);
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
  }, [close, closeUnlessDragging, drop, watchDrop]);

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
      disabled={disabled}
      highlighted={highlighted}
      hub={hub}
      work={work}
      onPointer={setPointer}
      onSelect={(index) => void convert(files, index)}
      onPickFile={canPick ? () => void pick() : undefined}
      onOutsideClick={close}
    />
  );
}
