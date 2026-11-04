import { useRef, type CSSProperties, type MouseEvent } from "react";
import { AppsIcon } from "../AppsIcon";
import { FilmIcon } from "../FilmIcon";
import { GemIcon } from "../GemIcon";
import type { Mode, WheelItem } from "./formats";
import {
  BUTTON_RADIUS,
  CENTER,
  DISK_RADIUS,
  HUB_RADIUS,
  SEPARATOR_END,
  SEPARATOR_START,
  WINDOW_SIZE,
  buttonCenter,
  isInsideDisk,
  polar,
  sectorPath,
  separatorAngles,
} from "./geometry";
import { type HubText, type Point, usableSector } from "./selection";

export type Phase = "open" | "closing" | "closed";

/** Conversion lancée depuis la part `index`. */
export interface Work {
  index: number;
  state: "working" | "done" | "failed";
  /** Avancement de 0 à 1, connu pour les vidéos. */
  progress?: number;
  /** Une app ouverte plutôt qu'un fichier converti. */
  opened?: boolean;
}

interface WheelProps {
  phase: Phase;
  mode: Mode;
  /** Roue suivante au clic sur le centre, `null` si une seule roue est active. */
  next: Mode | null;
  items: readonly WheelItem[];
  disabled: Set<string>;
  highlighted: number | null;
  hub: HubText | null;
  work: Work | null;
  onPointer: (point: Point | null) => void;
  onSelect: (index: number) => void;
  onOutsideClick: () => void;
  /** Clic au centre : passe du mode Images au mode Vidéo, et inversement. */
  onToggleMode: () => void;
}

const MODE_NAMES: Record<Mode, string> = { image: "Images", video: "Vidéo", apps: "Apps" };

function ModeIcon({ mode, size }: { mode: Mode; size: number }) {
  if (mode === "video") return <FilmIcon size={size} />;
  if (mode === "apps") return <AppsIcon size={size} />;
  return <GemIcon size={size} />;
}

/** Contenu d'une part : icône d'app, « + » pour une part vide, ou nom du format. */
function ItemContent({ item }: { item: WheelItem }) {
  if (item.icon) return <img className="app-icon" src={item.icon} alt="" draggable={false} />;
  if (item.empty) return <span className="item-add">+</span>;
  return <span className="item-label">{item.label}</span>;
}

/** Anneau d'avancement d'une conversion vidéo. */
function ProgressRing({ progress }: { progress: number }) {
  const radius = 12;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg className="progress-ring" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
      <circle className="progress-track" cx="15" cy="15" r={radius} />
      <circle
        className="progress-value"
        cx="15"
        cy="15"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progress)}
      />
    </svg>
  );
}

function localPoint(event: MouseEvent<HTMLElement>): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

/**
 * Angle de la part éclairée. Elle tourne vers la nouvelle part par le plus court chemin,
 * et apparaît directement en place quand rien n'était éclairé.
 */
function useWedge(highlighted: number | null) {
  const angle = useRef(0);
  const wasVisible = useRef(false);
  const appearing = highlighted !== null && !wasVisible.current;
  if (highlighted !== null) {
    const target = highlighted * 60;
    const delta = ((((target - angle.current) % 360) + 540) % 360) - 180;
    angle.current += delta;
  }
  wasVisible.current = highlighted !== null;
  return { angle: angle.current, appearing };
}

function HubContent({ hub, work, mode }: { hub: HubText | null; work: Work | null; mode: Mode }) {
  if (work?.state === "working") {
    if (work.progress !== undefined) {
      return (
        <>
          <ProgressRing progress={work.progress} />
          <span className="hub-label" data-tone="muted">
            {Math.round(work.progress * 100)} %
          </span>
        </>
      );
    }
    return (
      <>
        <span className="spinner" aria-hidden="true" />
        <span className="hub-label" data-tone="muted">
          {work.opened ? "Ouverture…" : "Conversion…"}
        </span>
      </>
    );
  }
  if (work) {
    const done = work.state === "done";
    return (
      <span className="hub-result" data-state={work.state}>
        <span className="hub-result-icon" aria-hidden="true">
          {done ? "✓" : "!"}
        </span>
        <span className="hub-label" data-tone="action">
          {done ? (work.opened ? "Ouvert" : "Converti") : "Échec"}
        </span>
      </span>
    );
  }
  if (!hub) {
    return (
      // La clé rejoue le retournement à chaque changement de mode
      <span className="hub-text hub-mode" key={mode}>
        <ModeIcon mode={mode} size={30} />
        <span className="hub-label" data-tone="muted">
          {MODE_NAMES[mode]}
        </span>
      </span>
    );
  }
  return (
    // La clé relance l'animation d'apparition à chaque changement de texte
    <span className="hub-text" key={hub.label}>
      {hub.tone === "file" && <ModeIcon mode={mode} size={18} />}
      <span className="hub-label" data-tone={hub.tone}>
        {hub.label}
      </span>
      {hub.hint && <span className="hub-hint">{hub.hint}</span>}
    </span>
  );
}

export function Wheel({
  phase,
  mode,
  next,
  items,
  disabled,
  highlighted,
  hub,
  work,
  onPointer,
  onSelect,
  onOutsideClick,
  onToggleMode,
}: WheelProps) {
  const wedge = useWedge(highlighted);
  const busy = work !== null;

  // Un clic n'importe où dans une part vaut un clic sur son bouton
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("button")) return;
    const [x, y] = localPoint(event);
    if (!isInsideDisk(x, y)) {
      onOutsideClick();
      return;
    }
    const index = usableSector(x, y, disabled, items);
    if (index !== null) onSelect(index);
  };

  return (
    <div
      className="wheel-root"
      data-busy={busy}
      onPointerMove={busy ? undefined : (event) => onPointer(localPoint(event))}
      onPointerLeave={busy ? undefined : () => onPointer(null)}
      onClick={busy ? undefined : handleClick}
    >
      <div className="wheel" data-phase={phase}>
        <svg
          className="wheel-disk"
          width={WINDOW_SIZE}
          height={WINDOW_SIZE}
          viewBox={`0 0 ${WINDOW_SIZE} ${WINDOW_SIZE}`}
          aria-hidden="true"
        >
          <defs>
            <radialGradient
              id="wedge-glow"
              gradientUnits="userSpaceOnUse"
              cx={CENTER}
              cy={CENTER}
              r={DISK_RADIUS}
            >
              <stop offset={HUB_RADIUS / DISK_RADIUS} className="wedge-stop-inner" />
              <stop offset="1" className="wedge-stop-outer" />
            </radialGradient>
          </defs>
          <circle className="disk" cx={CENTER} cy={CENTER} r={DISK_RADIUS - 0.75} />
          <path
            className="wedge"
            d={sectorPath(0)}
            data-visible={highlighted !== null}
            data-appearing={wedge.appearing}
            style={{ transform: `rotate(${wedge.angle}deg)` }}
          />
          {separatorAngles().map((angle) => {
            const [x1, y1] = polar(SEPARATOR_START, angle);
            const [x2, y2] = polar(SEPARATOR_END, angle);
            return <line key={angle} className="separator" x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
        </svg>

        {items.map((format, index) => {
          const [x, y] = buttonCenter(index);
          const style = {
            left: x - BUTTON_RADIUS,
            top: y - BUTTON_RADIUS,
            width: BUTTON_RADIUS * 2,
            height: BUTTON_RADIUS * 2,
            "--order": index,
          } as CSSProperties;
          const isDisabled = disabled.has(format.id);
          return (
            <button
              // La clé change avec le mode : les boutons réapparaissent l'un après l'autre
              key={`${mode}-${format.id}`}
              type="button"
              className="format-button"
              data-kind={
                format.icon ? "icon" : format.empty ? "add" : mode === "apps" ? "name" : "format"
              }
              style={style}
              disabled={isDisabled || busy}
              data-unavailable={isDisabled}
              data-active={highlighted === index}
              title={mode === "apps" && !format.empty ? format.label : undefined}
              aria-label={
                isDisabled
                  ? `${format.label}, indisponible`
                  : (format.action ?? `Convertir en ${format.label}`)
              }
              onFocus={() => onPointer(buttonCenter(index))}
              onBlur={() => onPointer(null)}
              onClick={() => onSelect(index)}
            >
              <ItemContent item={format} />
            </button>
          );
        })}

        {busy || !next ? (
          <div className="hub" title={hub?.title} aria-live="polite">
            <HubContent hub={hub} work={work} mode={mode} />
          </div>
        ) : (
          <button
            type="button"
            className="hub hub-toggle"
            title={hub?.title}
            aria-label={`Passer à la roue ${MODE_NAMES[next]}`}
            onClick={onToggleMode}
          >
            <HubContent hub={hub} work={work} mode={mode} />
          </button>
        )}
      </div>
    </div>
  );
}
