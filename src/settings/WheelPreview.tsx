import { useState } from "react";
import type { WheelBorder } from "../ipc";
import type { Mode, WheelItem } from "../wheel/formats";
import { CENTER, isInsideHub } from "../wheel/geometry";
import { type Point, usableSector } from "../wheel/selection";
import { Wheel } from "../wheel/Wheel";

/** Échelle de l'aperçu de la roue dans les réglages. */
const PREVIEW_SCALE = 0.6;

const NOTHING_DISABLED = new Set<string>();

/** Roue réduite, telle qu'elle s'affichera. Le survol y fonctionne comme sur la vraie ; un clic
 * sur une part, ou sur le centre, est rendu à l'onglet qui la montre. */
export function WheelPreview({
  mode,
  title,
  items,
  accent,
  border,
  glass,
  selected = null,
  partLabel,
  hubLabel,
  onPart,
  onHub,
}: {
  mode: Mode;
  /** Nom d'une roue personnalisée, affiché au centre. */
  title?: string;
  /** Parts déjà à leurs couleurs. */
  items: readonly WheelItem[];
  accent: string | null;
  border: WheelBorder;
  glass: boolean;
  /** Part gardée éclairée quand la souris est ailleurs. */
  selected?: number | null;
  /** Ce qu'annonce le centre au survol d'une part. */
  partLabel: (item: WheelItem) => string;
  /** Ce qu'annonce le centre quand on le survole ; sans `onHub`, il n'est pas cliquable. */
  hubLabel?: string;
  onPart: (index: number) => void;
  onHub?: () => void;
}) {
  const [pointer, setPointer] = useState<Point | null>(null);
  const hoveredIndex = pointer && usableSector(...pointer, NOTHING_DISABLED, items);
  const hovered = hoveredIndex === null ? null : items[hoveredIndex];
  const overHub = pointer !== null && isInsideHub(...pointer);
  return (
    <div
      className="wheel-preview"
      style={{ width: CENTER * 2 * PREVIEW_SCALE, height: CENTER * 2 * PREVIEW_SCALE }}
    >
      <div style={{ transform: `scale(${PREVIEW_SCALE})`, transformOrigin: "top left" }}>
        <Wheel
          phase="open"
          mode={mode}
          // Le centre n'est un bouton que s'il mène quelque part
          next={onHub ? mode : null}
          title={title}
          items={items}
          disabled={NOTHING_DISABLED}
          highlighted={hoveredIndex ?? (overHub ? null : selected)}
          hub={
            hovered
              ? { label: partLabel(hovered), tone: "action" }
              : overHub && onHub && hubLabel
                ? { label: hubLabel, tone: "action" }
                : null
          }
          work={null}
          dwelling={false}
          dwellMs={1000}
          accent={accent}
          border={border}
          glass={glass ? "css" : "off"}
          scale={PREVIEW_SCALE}
          onPointer={setPointer}
          onSelect={onPart}
          onOutsideClick={() => {}}
          onToggleMode={() => onHub?.()}
        />
      </div>
    </div>
  );
}
