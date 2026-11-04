import { useRef, type CSSProperties, type MouseEvent } from "react";
import { GemIcon } from "../GemIcon";
import { OUTPUT_FORMATS } from "./formats";
import type { OutputFormat } from "./formats";
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
}

interface WheelProps {
  phase: Phase;
  disabled: Set<OutputFormat>;
  highlighted: number | null;
  hub: HubText | null;
  work: Work | null;
  onPointer: (point: Point | null) => void;
  onSelect: (index: number) => void;
  onOutsideClick: () => void;
  /** Présent quand aucun fichier n'est connu : le centre devient le bouton « Choisir… ». */
  onPickFile?: () => void;
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

function HubContent({ hub, work }: { hub: HubText | null; work: Work | null }) {
  if (work?.state === "working") {
    return (
      <>
        <span className="spinner" aria-hidden="true" />
        <span className="hub-label" data-tone="muted">
          Conversion…
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
          {done ? "Converti" : "Échec"}
        </span>
      </span>
    );
  }
  if (!hub) return <GemIcon size={38} />;
  return (
    // La clé relance l'animation d'apparition à chaque changement de texte
    <span className="hub-text" key={hub.label}>
      {hub.tone === "file" && <GemIcon size={18} />}
      <span className="hub-label" data-tone={hub.tone}>
        {hub.label}
      </span>
      {hub.hint && <span className="hub-hint">{hub.hint}</span>}
    </span>
  );
}

export function Wheel({
  phase,
  disabled,
  highlighted,
  hub,
  work,
  onPointer,
  onSelect,
  onOutsideClick,
  onPickFile,
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
    const index = usableSector(x, y, disabled);
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

        {OUTPUT_FORMATS.map((format, index) => {
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
              key={format.id}
              type="button"
              className="format-button"
              style={style}
              disabled={isDisabled || busy}
              data-unavailable={isDisabled}
              data-active={highlighted === index}
              aria-label={isDisabled ? `${format.label}, indisponible` : `Convertir en ${format.label}`}
              onFocus={() => onPointer(buttonCenter(index))}
              onBlur={() => onPointer(null)}
              onClick={() => onSelect(index)}
            >
              {format.label}
            </button>
          );
        })}

        {onPickFile && !hub && !work ? (
          <button
            type="button"
            className="hub hub-picker"
            aria-label="Choisir les images à convertir"
            onClick={onPickFile}
          >
            <GemIcon size={26} />
            <span className="hub-label" data-tone="pick">
              Choisir…
            </span>
          </button>
        ) : (
          <div className="hub" title={hub?.title} aria-live="polite">
            <HubContent hub={hub} work={work} />
          </div>
        )}
      </div>
    </div>
  );
}
