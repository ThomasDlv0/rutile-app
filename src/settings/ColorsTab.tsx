import { useEffect, useMemo, useRef, useState } from "react";
import { type MessageKey, t, useLanguage } from "../i18n";
import { WheelsIcon } from "../WheelsIcon";
import type { CustomWheel, CustomWheelView, SettingsTab, SettingsView, WheelBorder } from "../ipc";
import { type ActionNode, actionTree, colorizeActions, customTree } from "../wheel/actions";
import { DEFAULT_ACCENT } from "../wheel/color";
import {
  type Mode,
  OUTPUT_FORMATS,
  VIDEO_FORMATS,
  type WheelItem,
  colorize,
  customMode,
} from "../wheel/formats";
import { ModeIcon } from "../wheel/Wheel";
import { BubbleGroup } from "./Bubble";
import { type Change, Row, SLIDER_COMMIT_MS, Section, Toggle } from "./controls";
import { WheelPreview } from "./WheelPreview";

/** Roue dont on règle les couleurs : une roue de Rutile, ou une roue perso (`custom`, son
 * rang dans les réglages). */
type ColorWheel = { key: Mode; title: string; custom: number | null };

/** Couleurs proposées d'un clic : celles d'origine des parts. Toute autre se choisit dans le
 * sélecteur du système. */
const PALETTE: { color: string; name: MessageKey }[] = [
  { color: "#3b82f6", name: "settings.colors.palette.blue" },
  { color: "#0d9488", name: "settings.colors.palette.turquoise" },
  { color: "#16a34a", name: "settings.colors.palette.green" },
  { color: "#f2b705", name: "settings.colors.palette.yellow" },
  { color: "#f97316", name: "settings.colors.palette.orange" },
  { color: "#e5484d", name: "settings.colors.palette.red" },
  { color: "#ec4899", name: "settings.colors.palette.pink" },
  { color: "#8b5cf6", name: "settings.colors.palette.purple" },
  { color: "#64748b", name: "settings.colors.palette.slate" },
  { color: "#6b7280", name: "settings.colors.palette.gray" },
];

/** Ce dont on règle la couleur quand ce n'est pas une part : la surbrillance. */
const HIGHLIGHT = "highlight";

type ColorDraft = {
  colors: Record<string, string>;
  highlight: string | null;
  border: WheelBorder;
  borderColor: string | null;
  /** Couleur propre de chaque part des roues perso : par roue, dans l'ordre de ses parts. */
  parts: Record<string, (string | null)[]>;
};

/** Couleurs propres des parts des roues perso, telles qu'enregistrées. */
function partColors(wheels: readonly CustomWheel[]): ColorDraft["parts"] {
  return Object.fromEntries(
    wheels.map((wheel) => [wheel.id, wheel.parts.map((part) => part.color ?? null)]),
  );
}

/** Les roues perso telles qu'on les affiche, avec les couleurs propres de `parts`. */
function withPartColors(
  custom: readonly CustomWheelView[],
  parts: ColorDraft["parts"],
): CustomWheelView[] {
  return custom.map((wheel) => ({
    ...wheel,
    parts: wheel.parts.map((part, slot) => ({ ...part, color: parts[wheel.id]?.[slot] ?? null })),
  }));
}

/** Rang d'une part de roue perso, d'après l'identifiant de sa part sur la roue. */
const slotOf = (id: string) => Number(id.split("-")[2]);

const BORDERS: { id: WheelBorder; label: MessageKey }[] = [
  { id: "none", label: "settings.colors.border.none" },
  { id: "light", label: "settings.colors.border.light" },
  { id: "dark", label: "settings.colors.border.dark" },
  { id: "color", label: "settings.colors.border.color" },
];

export function ColorsTab({
  view,
  custom,
  error,
  change,
  goTo,
}: {
  view: SettingsView;
  /** Roues perso telles qu'elles s'affichent, avec les icônes de leurs parts. */
  custom: readonly CustomWheelView[];
  error?: string;
  change: Change;
  goTo: (tab: SettingsTab, anchor?: string) => void;
}) {
  const { settings } = view;
  const lang = useLanguage();
  // Les couleurs s'appliquent à l'aperçu tout de suite, et s'enregistrent un instant après
  const { formatColors, highlightColor, wheelBorder, wheelBorderColor, customWheels } = settings;
  const saved = (): ColorDraft => ({
    colors: formatColors,
    highlight: highlightColor,
    border: wheelBorder,
    borderColor: wheelBorderColor,
    parts: partColors(customWheels),
  });
  const [draft, setDraft] = useState<ColorDraft>(saved);
  const timer = useRef<number | undefined>(undefined);
  useEffect(
    () => setDraft(saved()),
    [formatColors, highlightColor, wheelBorder, wheelBorderColor, customWheels],
  );

  const update = (next: ColorDraft) => {
    setDraft(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () =>
        change("colors", {
          formatColors: next.colors,
          highlightColor: next.highlight,
          wheelBorder: next.border,
          wheelBorderColor: next.borderColor,
          customWheels: customWheels.map((wheel) => ({
            ...wheel,
            parts: wheel.parts.map((part, slot) => ({
              ...part,
              color: next.parts[wheel.id]?.[slot] ?? null,
            })),
          })),
        }),
      SLIDER_COMMIT_MS,
    );
  };

  // Roues de Rutile qui ont des couleurs, puis celles de l'utilisateur, sous leur nom
  const wheels: ColorWheel[] = [
    { key: "image", title: t("settings.colors.wheel.image"), custom: null },
    { key: "video", title: t("settings.colors.wheel.video"), custom: null },
    { key: "actions", title: t("settings.colors.wheel.actions"), custom: null },
    ...customWheels.map((wheel, index) => ({
      key: customMode(wheel.id),
      title: wheel.name || t("settings.common.unnamed"),
      custom: index,
    })),
  ];
  const [shown, setShown] = useState<Mode>("image");
  const wheel = wheels.find(({ key }) => key === shown) ?? wheels[0];

  const windowLayout = view.platform !== "linux" || !view.wayland;
  const actionParts = useMemo(
    () => actionTree({ windowLayout: true, actionParts: settings.actionParts }),
    // Les libellés des actions suivent la langue
    [settings.actionParts, lang],
  );
  // Parts de la roue affichée telles qu'à l'origine, puis à leurs couleurs. L'origine d'une
  // part perso est la couleur de son format ou de son action
  const [original, items]: [readonly WheelItem[], readonly WheelItem[]] = (() => {
    if (wheel.custom === null) {
      const parts =
        wheel.key === "actions" ? actionParts : wheel.key === "video" ? VIDEO_FORMATS : OUTPUT_FORMATS;
      return [parts, colorize(parts, draft.colors)];
    }
    const tree = (wheels: CustomWheelView[]) =>
      colorizeActions(customTree({ windowLayout, custom: wheels }, wheel.custom!), draft.colors);
    return [tree(withPartColors(custom, {})), tree(withPartColors(custom, draft.parts))];
  })();

  // Ce dont on règle la couleur : une part de la roue affichée, choisie d'un clic sur
  // l'aperçu, ou la surbrillance par son centre. La première part l'est d'emblée, pour que
  // les couleurs proposées soient sous les yeux dès l'arrivée
  const [target, setTarget] = useState<string>("");
  const selected =
    target === HIGHLIGHT ? -1 : Math.max(items.findIndex(({ id }) => id === target), 0);
  const part = target === HIGHLIGHT ? null : (items[selected] ?? null);
  const origin = part ? (original[selected]?.color ?? DEFAULT_ACCENT) : DEFAULT_ACCENT;
  const current = part ? (part.color ?? origin) : (draft.highlight ?? DEFAULT_ACCENT);
  // Une app, un dossier ou un site montre son icône : sa couleur ne se verrait pas
  const colorable = !part?.icon;

  const setHighlight = (color: string) =>
    update({ ...draft, highlight: color === DEFAULT_ACCENT ? null : color });
  const setColor = (color: string) => {
    if (!part) {
      setHighlight(color);
      return;
    }
    // Revenir à la couleur d'origine retire le choix, plutôt que de l'enregistrer
    const chosen = color === origin ? null : color;
    if (wheel.custom !== null) {
      const id = customWheels[wheel.custom].id;
      const colors = [...(draft.parts[id] ?? [])];
      colors[slotOf(part.id)] = chosen;
      update({ ...draft, parts: { ...draft.parts, [id]: colors } });
      return;
    }
    const colors = { ...draft.colors };
    if (chosen === null) delete colors[part.id];
    else colors[part.id] = chosen;
    update({ ...draft, colors });
  };

  const borderColor = draft.borderColor ?? draft.highlight ?? DEFAULT_ACCENT;
  const setBorder = (border: WheelBorder) =>
    // La couleur du contour part de celle de la surbrillance
    update({ ...draft, border, borderColor: border === "color" ? borderColor : draft.borderColor });
  const customized =
    Object.keys(draft.colors).length > 0 ||
    draft.highlight !== null ||
    draft.border !== "none" ||
    Object.values(draft.parts).some((colors) => colors.some((color) => color !== null));
  const title = part
    ? t("settings.colors.partTitle", { part: part.label })
    : t("settings.colors.highlightTitle");
  const hint = !part
    ? t("settings.colors.hint.highlight")
    : !colorable
      ? t("settings.colors.hint.icon")
      : wheel.custom !== null
        ? t(
            (part as ActionNode).children
              ? "settings.colors.hint.customWithOptions"
              : "settings.colors.hint.custom",
          )
        : wheel.key === "actions"
          ? t("settings.colors.hint.actions")
          : t("settings.colors.hint.format");
  const customId = wheel.custom === null ? null : customWheels[wheel.custom].id;

  return (
    <>
      <Section title={t("settings.colors.parts.title")} error={error}>
        <div className="color-preview">
          <BubbleGroup
            className="chips"
            role="tablist"
            label={t("settings.colors.parts.shown")}
            selected={`${wheel.key} ${wheels.map(({ title }) => title).join()}`}
          >
            {wheels.map(({ key, title }) => (
              <button
                key={key}
                type="button"
                role="tab"
                className="chip"
                aria-selected={key === wheel.key}
                onClick={() => {
                  setShown(key);
                  setTarget("");
                }}
              >
                <ModeIcon mode={key} size={14} />
                <span>{title}</span>
              </button>
            ))}
          </BubbleGroup>
          {items.length > 0 ? (
            <>
              <WheelPreview
                // Une nouvelle roue s'affiche sans glisser depuis la précédente
                key={wheel.key}
                mode={wheel.key}
                title={wheel.custom === null ? undefined : wheel.title}
                items={items}
                accent={draft.highlight}
                border={draft.border}
                borderColor={borderColor}
                glass={settings.wheelGlass}
                selected={part ? selected : null}
                partLabel={(item) => t("settings.colors.partTitle", { part: item.label })}
                hubLabel={t("settings.colors.highlightTitle")}
                onPart={(index) => setTarget(items[index].id)}
                onHub={() => setTarget(HIGHLIGHT)}
              />
              <p className="row-hint">
                {t("settings.colors.parts.click")}
              </p>
            </>
          ) : (
            <div className="color-empty">
              <span className="color-empty-ring" aria-hidden="true">
                <WheelsIcon size={34} />
              </span>
              <p>{t("settings.colors.parts.empty", { name: wheel.title })}</p>
              <button
                type="button"
                className="link-button"
                onClick={() => customId && goTo("custom", customId)}
              >
                {t("settings.colors.parts.addParts")}
              </button>
            </div>
          )}
        </div>
        <div className="color-inspector">
          <div className="color-inspector-head">
            <span
              className="color-well"
              data-icon={!colorable || undefined}
              style={colorable ? { background: current } : undefined}
              aria-hidden="true"
            >
              {!colorable && part?.icon && <img src={part.icon} alt="" />}
            </span>
            <div className="row-text">
              <span className="row-label">{title}</span>
              <span className="row-hint">{hint}</span>
            </div>
            {colorable && <span className="color-field-code">{current.toUpperCase()}</span>}
          </div>
          {colorable && (
            <Swatches label={title} current={current} original={origin} onPick={setColor} />
          )}
        </div>
      </Section>

      <Section title={t("settings.colors.material.title")}>
        <Row
          label="Liquid Glass"
          hint={
            view.nativeGlass
              ? t("settings.colors.glass.hintNative")
              : t("settings.colors.glass.hintFake")
          }
        >
          <Toggle
            checked={settings.wheelGlass}
            label="Liquid Glass"
            onChange={(wheelGlass) => change("colors", { wheelGlass })}
          />
        </Row>
        <Row stacked label={t("settings.colors.border.label")} hint={t("settings.colors.border.hint")}>
          <BubbleGroup
            className="segmented segmented-fill"
            role="radiogroup"
            label={t("settings.colors.border.label")}
            selected={draft.border}
          >
            {BORDERS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={draft.border === id}
                onClick={() => setBorder(id)}
              >
                {id === "none" ? (
                  <span className="border-sample" data-border="none" aria-hidden="true" />
                ) : (
                  <span
                    className="border-sample"
                    data-border={id}
                    style={id === "color" ? { borderColor } : undefined}
                    aria-hidden="true"
                  />
                )}
                {t(label)}
              </button>
            ))}
          </BubbleGroup>
          {draft.border === "color" && (
            <Swatches
              label={t("settings.colors.border.colorAria")}
              current={borderColor}
              onPick={(color) => update({ ...draft, borderColor: color })}
            />
          )}
        </Row>
      </Section>

      <Section title={t("settings.colors.highlight.title")}>
        <Row label={t("settings.colors.highlight.hovered")} hint={t("settings.colors.highlight.hoveredHint")}>
          <ColorField
            label={t("settings.colors.highlight.hovered")}
            value={draft.highlight ?? DEFAULT_ACCENT}
            onChange={setHighlight}
          />
        </Row>
        <Row
          label={t("settings.colors.original.label")}
          hint={t("settings.colors.original.hint")}
        >
          <button
            type="button"
            className="shortcut-button"
            disabled={!customized}
            onClick={() =>
              update({
                colors: {},
                highlight: null,
                border: "none",
                borderColor: null,
                parts: Object.fromEntries(
                  Object.entries(draft.parts).map(([id, colors]) => [id, colors.map(() => null)]),
                ),
              })
            }
          >
            {t("settings.colors.original.reset")}
          </button>
        </Row>
      </Section>
    </>
  );
}

/** Pastilles de la palette, le sélecteur du système pour toute autre couleur, et le retour à
 * la couleur d'origine quand il y en a une. */
function Swatches({
  label,
  current,
  original,
  onPick,
}: {
  label: string;
  current: string;
  original?: string;
  onPick: (color: string) => void;
}) {
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {PALETTE.map(({ color, name }) => (
        <button
          key={color}
          type="button"
          role="radio"
          className="swatch"
          aria-checked={current === color}
          aria-label={t(name)}
          title={t(name)}
          style={{ background: color }}
          onClick={() => onPick(color)}
        />
      ))}
      <label
        className="swatch swatch-custom"
        title={t("settings.colors.swatch.more")}
        data-current={!PALETTE.some(({ color }) => color === current) || undefined}
      >
        <input
          type="color"
          aria-label={t("settings.colors.swatch.otherAria")}
          value={current}
          onChange={(event) => onPick(event.target.value.toLowerCase())}
        />
      </label>
      {original !== undefined && (
        <button
          type="button"
          className="link-button swatches-reset"
          disabled={current === original}
          onClick={() => onPick(original)}
        >
          {t("settings.colors.swatch.original")}
        </button>
      )}
    </div>
  );
}

/** Pastille de couleur qui ouvre le sélecteur du système, avec son code. */
function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <label className="color-field">
      <input
        type="color"
        aria-label={t("settings.colors.fieldAria", { label })}
        value={value}
        onChange={(event) => onChange(event.target.value.toLowerCase())}
      />
      <span className="color-field-code">{value.toUpperCase()}</span>
    </label>
  );
}
