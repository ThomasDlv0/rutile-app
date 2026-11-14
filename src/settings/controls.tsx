import { useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n";
import type { Settings } from "../ipc";
import type { SortableRow, useSortable } from "./useSortable";

/** Partie des réglages qu'un enregistrement concerne : ses erreurs s'affichent sous elle. */
export type SectionId =
  | "wheels"
  | "colors"
  | "actions"
  | "custom"
  | "apps"
  | "share"
  | "shortcut"
  | "shake"
  | "quality"
  | "startup"
  | "updates"
  | "language";

export type Change = (section: SectionId, patch: Partial<Settings>) => void;
export type Errors = Partial<Record<SectionId, string>>;

/** Les curseurs n'enregistrent qu'une fois relâchés depuis un court instant. */
export const SLIDER_COMMIT_MS = 300;

/** Icône d'app ou de destination, ou initiale (« + » pour une part vide). */
export function ItemIcon({
  icon,
  name,
  small,
}: {
  icon?: string | null;
  name?: string;
  small?: boolean;
}) {
  if (icon) {
    return <img className="settings-app-icon" data-small={small} src={icon} alt="" />;
  }
  return (
    <span className="settings-app-placeholder" data-small={small} aria-hidden="true">
      {name ? name.slice(0, 1) : "+"}
    </span>
  );
}

export function Section({
  title,
  error,
  sorting,
  note,
  action,
  id,
  children,
}: {
  title: string;
  error?: string;
  /** Une ligne est en train d'être glissée : les autres s'écartent en douceur. */
  sorting?: boolean;
  /** Explication sous la carte : hors d'elle, pour ne pas passer pour une option. */
  note?: ReactNode;
  /** Bouton discret en face du titre. */
  action?: ReactNode;
  /** Ancre, pour y amener depuis un autre onglet. */
  id?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section" id={id}>
      <div className="section-head">
        <h2>{title}</h2>
        {action}
      </div>
      <div className="settings-card" data-sorting={sorting || undefined}>
        {children}
      </div>
      {note && <p className="section-footnote">{note}</p>}
      {error && (
        <p className="section-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function Row({
  label,
  hint,
  icon,
  muted,
  sortable,
  handle,
  stacked,
  children,
}: {
  label: string;
  hint?: string;
  icon?: ReactNode;
  muted?: boolean;
  /** Le réglage passe sous son nom, sur toute la largeur. */
  stacked?: boolean;
  /** Ligne d'une liste qu'on réordonne en glissant, par sa poignée `handle`. */
  sortable?: SortableRow;
  handle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="settings-row"
      data-muted={muted}
      data-stacked={stacked || undefined}
      data-dragging={sortable?.dragging || undefined}
      ref={sortable?.ref}
      style={sortable?.style}
    >
      {handle}
      {icon && <span className="row-icon">{icon}</span>}
      <div className="row-text">
        <span className="row-label">{label}</span>
        {hint && <span className="row-hint">{hint}</span>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

/** Poignée d'une ligne déplaçable : à glisser, ou flèches haut et bas au clavier. */
export function DragHandle({
  label,
  ...handle
}: { label: string } & ReturnType<ReturnType<typeof useSortable>["handle"]>) {
  return (
    <button
      type="button"
      className="drag-handle"
      aria-label={t("settings.controls.move", { label })}
      title={t("settings.controls.drag")}
      {...handle}
    >
      <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
        {[3, 8, 13].flatMap((y) =>
          [2.5, 7.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.4" />),
        )}
      </svg>
    </button>
  );
}

/** Dernière ligne d'une liste : ajoute un élément. */
export function AddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="settings-row add-row" onClick={onClick}>
      <span className="add-row-icon" aria-hidden="true">
        +
      </span>
      <span className="row-label">{label}</span>
    </button>
  );
}

export function Toggle({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="toggle"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  disabled,
  showValue,
  formatValue = String,
  ends,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  showValue?: boolean;
  formatValue?: (value: number) => string;
  ends?: [string, string];
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setDraft(value), [value]);

  const update = (next: number) => {
    setDraft(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onCommit(next), SLIDER_COMMIT_MS);
  };

  return (
    <div className="slider" data-disabled={disabled}>
      {ends && <span className="slider-end">{ends[0]}</span>}
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        style={{ "--fill": `${((draft - min) / (max - min)) * 100}%` } as React.CSSProperties}
        onChange={(event) => update(Number(event.target.value))}
      />
      {ends && <span className="slider-end">{ends[1]}</span>}
      {showValue && <span className="slider-value">{formatValue(draft)}</span>}
    </div>
  );
}

