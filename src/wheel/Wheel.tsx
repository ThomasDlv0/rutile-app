import { useEffect, useRef, type CSSProperties, type MouseEvent } from "react";
import { ActionsIcon } from "../ActionsIcon";
import { AppsIcon } from "../AppsIcon";
import { FilmIcon } from "../FilmIcon";
import { GemIcon } from "../GemIcon";
import { ShareIcon } from "../ShareIcon";
import { WheelsIcon } from "../WheelsIcon";
import type { WheelBorder, WheelConfig } from "../ipc";
import { ActionGlyph } from "./ActionGlyph";
import { type BuiltinMode, type Mode, type WheelItem, isCustomMode } from "./formats";
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
  sectorCenterAngle,
  sectorPath,
  separatorAngles,
} from "./geometry";
import { DEFAULT_ACCENT, glow } from "./color";
import { type HubText, type Point, digitSector, stepSector, usableSector } from "./selection";

export type Phase = "open" | "closing" | "closed";

/** Conversion lancée depuis la part `index`. */
export interface Work {
  index: number;
  state: "working" | "done" | "failed";
  /** Avancement de 0 à 1, connu pour les vidéos. */
  progress?: number;
  /** Textes pendant et après l'action, « Conversion… » et « Converti » par défaut. */
  labels?: { working: string; done: string };
}

interface WheelProps {
  phase: Phase;
  mode: Mode;
  /** Roue suivante au clic sur le centre, `null` si une seule roue est active. */
  next: Mode | null;
  /** Nom de la roue affichée et de la suivante, quand ce sont des roues personnalisées. */
  title?: string;
  nextTitle?: string;
  items: readonly WheelItem[];
  disabled: Set<string>;
  highlighted: number | null;
  hub: HubText | null;
  work: Work | null;
  /** Fichier maintenu au centre : un anneau se remplit pendant `dwellMs` avant la bascule. */
  dwelling: boolean;
  dwellMs: number;
  /** Part sur laquelle on reste : son anneau se remplit avant d'ouvrir sa sous-roue. */
  dwellPart?: number | null;
  /** Sous-roue ouverte : le centre ramène à la roue d'avant. */
  back?: boolean;
  /** Couleur de la part survolée, choisie dans les réglages ; le bleu d'origine sinon. */
  accent?: string | null;
  border?: WheelBorder;
  /** Couleur du contour « color » ; le bleu d'origine sinon. */
  borderColor?: string | null;
  glass?: WheelConfig["glass"];
  /** Échelle d'affichage, pour l'aperçu réduit des réglages. */
  scale?: number;
  /** La roue répond au clavier de toute la fenêtre (pas l'aperçu des réglages). */
  keyboard?: boolean;
  /** `keyboard` : la part est choisie au clavier, pas pointée. */
  onPointer: (point: Point | null, keyboard?: boolean) => void;
  onSelect: (index: number) => void;
  onOutsideClick: () => void;
  /** Clic au centre : passe à la roue suivante. */
  onToggleMode: () => void;
}

const MODE_NAMES: Record<BuiltinMode, string> = {
  image: "Images",
  video: "Vidéo",
  apps: "Apps",
  share: "Partage",
  actions: "Actions",
};

/** Nom court d'une roue ; `title` est celui d'une roue personnalisée. */
function modeName(mode: Mode, title?: string): string {
  return isCustomMode(mode) ? title || "Ma roue" : MODE_NAMES[mode];
}

export function ModeIcon({ mode, size }: { mode: Mode; size: number }) {
  if (isCustomMode(mode)) return <WheelsIcon size={size} />;
  if (mode === "video") return <FilmIcon size={size} />;
  if (mode === "apps") return <AppsIcon size={size} />;
  if (mode === "share") return <ShareIcon size={size} />;
  if (mode === "actions") return <ActionsIcon size={size} />;
  return <GemIcon size={size} />;
}

/** Roues dont les parts portent un nom (app, destination, action) plutôt qu'un format. */
const isNamed = (mode: Mode): boolean => mode !== "image" && mode !== "video";

/** Allure du bouton d'une part : une pastille de couleur pour un format ou une action,
 * l'icône seule pour une app, un « + » pour une part libre, sinon un nom. */
function itemKind(item: WheelItem, mode: Mode): "format" | "icon" | "add" | "name" {
  if (item.glyph || item.color) return "format";
  if (item.icon) return "icon";
  if (item.empty) return "add";
  return isNamed(mode) ? "name" : "format";
}

/** Contenu d'une part : icône d'app, « + » pour une part vide, ou nom du format. Une app
 * garde sa pastille de notifications, comme dans le Dock. */
function ItemContent({ item }: { item: WheelItem }) {
  const badge = item.badge && <span className="app-badge">{item.badge}</span>;
  if (item.glyph) return <ActionGlyph name={item.glyph} />;
  if (item.icon) {
    return (
      <>
        <img className="app-icon" src={item.icon} alt="" draggable={false} />
        {badge}
      </>
    );
  }
  if (item.empty) return <span className="item-add">+</span>;
  return (
    <>
      <span className="item-label">{item.label}</span>
      {badge}
    </>
  );
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

/** Position dans la roue, ramenée à sa taille réelle si elle est affichée réduite. */
function localPoint(event: MouseEvent<HTMLElement>, scale: number): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return [(event.clientX - rect.left) / scale, (event.clientY - rect.top) / scale];
}

/**
 * Angle de la part éclairée. Elle tourne vers la nouvelle part par le plus court chemin,
 * et apparaît directement en place quand rien n'était éclairé.
 */
function useWedge(highlighted: number | null, count: number) {
  const angle = useRef(0);
  const wasVisible = useRef(false);
  const appearing = highlighted !== null && !wasVisible.current;
  if (highlighted !== null) {
    const target = sectorCenterAngle(highlighted, count);
    const delta = ((((target - angle.current) % 360) + 540) % 360) - 180;
    angle.current += delta;
  }
  wasVisible.current = highlighted !== null;
  return { angle: angle.current, appearing };
}

function HubContent({
  hub,
  work,
  mode,
  title,
}: {
  hub: HubText | null;
  work: Work | null;
  mode: Mode;
  title?: string;
}) {
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
          {work.labels?.working ?? "Conversion…"}
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
          {done ? (work.labels?.done ?? "Converti") : "Échec"}
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
          {modeName(mode, title)}
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
  title,
  nextTitle,
  items,
  disabled,
  highlighted,
  hub,
  work,
  dwelling,
  dwellMs,
  dwellPart = null,
  back = false,
  accent,
  border = "none",
  borderColor = null,
  glass = "off",
  scale = 1,
  keyboard = false,
  onPointer,
  onSelect,
  onOutsideClick,
  onToggleMode,
}: WheelProps) {
  const count = items.length;
  const wedge = useWedge(highlighted, count);
  const busy = work !== null;
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  // ← → passent d'une part à l'autre : le focus l'éclaire et Entrée la lance. Un chiffre la
  // lance directement.
  useEffect(() => {
    if (!keyboard || busy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const digit = digitSector(event.code, count);
      if (digit !== null) {
        event.preventDefault();
        if (!event.repeat && !disabled.has(items[digit].id)) onSelect(digit);
        return;
      }
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const focused = buttons.current.findIndex(
        (button) => button !== null && button === document.activeElement,
      );
      const step = event.key === "ArrowRight" ? 1 : -1;
      const index = stepSector(focused >= 0 ? focused : highlighted, step, disabled, items);
      if (index !== null) buttons.current[index]?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keyboard, busy, count, disabled, items, highlighted, onSelect]);

  // Un clic n'importe où dans une part vaut un clic sur son bouton
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("button")) return;
    const [x, y] = localPoint(event, scale);
    if (!isInsideDisk(x, y)) {
      onOutsideClick();
      return;
    }
    const index = usableSector(x, y, disabled, items);
    if (index !== null) onSelect(index);
  };

  const colors = {
    ...(accent && {
      "--accent": accent,
      "--accent-glow": glow(accent),
      "--accent-ring": glow(accent, 0.6),
    }),
    ...(border === "color" && { "--disk-border": borderColor ?? accent ?? DEFAULT_ACCENT }),
  } as CSSProperties;

  return (
    <div
      className="wheel-root"
      style={colors}
      data-border={border}
      data-glass={glass}
      data-busy={busy}
      onPointerMove={busy ? undefined : (event) => onPointer(localPoint(event, scale))}
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
            <linearGradient id="glass-rim" x1="0.2" y1="0" x2="0.8" y2="1">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.75" />
              <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.12" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0.4" />
            </linearGradient>
            <radialGradient id="glass-sheen" cx="0.5" cy="0.08" r="0.75">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.2" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle className="disk" cx={CENTER} cy={CENTER} r={DISK_RADIUS - 0.75} />
          <circle className="disk-sheen" cx={CENTER} cy={CENTER} r={DISK_RADIUS - 2} />
          <path
            className="wedge"
            d={sectorPath(0, count)}
            data-visible={highlighted !== null}
            data-appearing={wedge.appearing}
            style={{ transform: `rotate(${wedge.angle}deg)` }}
          />
          {separatorAngles(count).map((angle) => {
            const [x1, y1] = polar(SEPARATOR_START, angle);
            const [x2, y2] = polar(SEPARATOR_END, angle);
            return <line key={angle} className="separator" x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
        </svg>

        {items.map((format, index) => {
          const [x, y] = buttonCenter(index, count);
          const style = {
            left: x - BUTTON_RADIUS,
            top: y - BUTTON_RADIUS,
            width: BUTTON_RADIUS * 2,
            height: BUTTON_RADIUS * 2,
            "--order": index,
            "--tile": format.color,
            "--ink": format.ink,
          } as CSSProperties;
          const isDisabled = disabled.has(format.id);
          return (
            <button
              // La clé change avec le mode : les boutons réapparaissent l'un après l'autre
              key={`${mode}-${format.id}`}
              ref={(button) => {
                buttons.current[index] = button;
              }}
              type="button"
              className="format-button"
              data-kind={itemKind(format, mode)}
              style={style}
              disabled={isDisabled || busy}
              data-unavailable={isDisabled}
              data-active={highlighted === index}
              title={isNamed(mode) && !format.empty ? format.label : undefined}
              aria-label={
                isDisabled
                  ? `${format.label}, indisponible`
                  : (format.action ?? `Convertir en ${format.label}`) +
                    (format.badge ? `, ${format.badge} notification(s)` : "")
              }
              onFocus={() => onPointer(buttonCenter(index, count), true)}
              onBlur={() => onPointer(null)}
              onClick={() => onSelect(index)}
            >
              <ItemContent item={format} />
              {dwellPart === index && (
                <svg
                  className="part-dwell"
                  viewBox="0 0 66 66"
                  aria-hidden="true"
                  style={{ "--dwell-ms": `${dwellMs}ms` } as CSSProperties}
                >
                  <circle cx="33" cy="33" r="31" />
                </svg>
              )}
            </button>
          );
        })}

        {dwelling && (
          <svg
            className="dwell-ring"
            viewBox="0 0 104 104"
            aria-hidden="true"
            style={{ "--dwell-ms": `${dwellMs}ms` } as CSSProperties}
          >
            <circle cx="52" cy="52" r="50" />
          </svg>
        )}
        {busy || (!next && !back) ? (
          <div className="hub" title={hub?.title} aria-live="polite">
            <HubContent hub={hub} work={work} mode={mode} title={title} />
          </div>
        ) : (
          <button
            type="button"
            className="hub hub-toggle"
            title={hub?.title}
            aria-label={
              next && !back
                ? `Passer à la roue ${modeName(next, nextTitle)}`
                : "Revenir à la roue d'avant"
            }
            onClick={onToggleMode}
          >
            <HubContent hub={hub} work={work} mode={mode} title={title} />
          </button>
        )}
      </div>
    </div>
  );
}
