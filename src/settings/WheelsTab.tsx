import { type MessageKey, language, t, tn } from "../i18n";
import type { FileWheels, FirstWheel, Settings, SettingsTab } from "../ipc";
import { FILE_KIND_LABELS } from "../wheel/actions";
import { type BuiltinMode, type Mode, customMode, isCustomMode } from "../wheel/formats";
import { ModeIcon } from "../wheel/Wheel";
import { AddRow, type Change, DragHandle, Row, Section, Slider, Toggle } from "./controls";
import { FILE_WHEELS_ANCHOR, withMode, FILE_KINDS } from "./shared";
import { moved, useSortable } from "./useSortable";

const MODE_LABELS: Record<BuiltinMode, MessageKey> = {
  image: "settings.mode.image",
  video: "settings.mode.video",
  apps: "settings.mode.apps",
  share: "settings.mode.share",
  actions: "settings.mode.actions",
};

/** Roues dans l'ordre du clic au centre : celui des réglages, puis celles qu'il ne cite pas
 * encore (une roue tout juste créée). */
function wheelKeys(settings: Settings): Mode[] {
  const known: Mode[] = [
    ...settings.modes.map((entry) => entry.id),
    ...settings.customWheels.map((wheel) => customMode(wheel.id)),
  ];
  const ordered = settings.wheelOrder.filter(
    (key, index, all) => known.includes(key) && all.indexOf(key) === index,
  );
  return [...ordered, ...known.filter((key) => !ordered.includes(key))];
}

/** Ce que fait chaque réglage « S'ouvre sur », en quelques mots. */
const FIRST_WHEEL_NAMES: Record<FirstWheel, MessageKey> = {
  convert: "settings.wheels.firstName.convert",
  actions: "settings.wheels.firstName.actions",
  share: "settings.wheels.firstName.share",
  apps: "settings.wheels.firstName.apps",
  usual: "settings.wheels.firstName.usual",
};

/** « Images, Vidéos : convertisseur · PDF, Archives, Autres : roue Actions ». */
function fileWheelsSummary(fileWheels: FileWheels): string {
  const groups = new Map<FirstWheel, string[]>();
  for (const kind of FILE_KINDS) {
    const { first } = fileWheels[kind];
    groups.set(first, [...(groups.get(first) ?? []), FILE_KIND_LABELS[kind]]);
  }
  return [...groups]
    .map(([first, kinds]) =>
      t("settings.wheels.fileSummary.item", {
        kinds: kinds.join(", "),
        wheel: t(FIRST_WHEEL_NAMES[first]),
      }),
    )
    .join(" · ");
}

/** Ligne de la liste des roues : une roue de Rutile ou une roue personnalisée. */
type WheelRow = {
  key: Mode;
  label: string;
  hint?: string;
  custom: boolean;
  enabled: boolean;
  /** Affichée quels que soient les fichiers. */
  always: boolean;
  toggle: (next: boolean) => void;
};

export function WheelsTab({
  settings,
  error,
  change,
  goTo,
}: {
  settings: Settings;
  error?: string;
  change: Change;
  goTo: (tab: SettingsTab, anchor?: string) => void;
}) {
  const keys = wheelKeys(settings);
  const sortable = useSortable(keys.length, (from, to) =>
    change("wheels", { wheelOrder: moved(keys, from, to) }),
  );
  const rows = keys.flatMap((key): WheelRow[] => {
    if (!isCustomMode(key)) {
      const enabled = settings.modes.some((entry) => entry.id === key && entry.enabled);
      const toggle = (next: boolean) => change("wheels", { modes: withMode(settings, key, next) });
      return [{ key, label: t(MODE_LABELS[key]), hint: undefined, custom: false, enabled, always: enabled, toggle }];
    }
    const wheel = settings.customWheels.find((known) => customMode(known.id) === key);
    if (!wheel) return [];
    const count = wheel.parts.length;
    const toggle = (next: boolean) =>
      change("wheels", {
        customWheels: settings.customWheels.map((known) =>
          known === wheel ? { ...known, enabled: next } : known,
        ),
      });
    return [
      {
        key,
        label: wheel.name || t("settings.common.unnamed"),
        hint:
          count === 0
            ? t("settings.wheels.customEmpty")
            : tn("settings.wheels.customParts", count),
        custom: true,
        enabled: wheel.enabled,
        // Affichée quels que soient les fichiers : elle peut rester la seule roue
        always: wheel.enabled && count > 0 && wheel.extensions.length === 0,
        toggle,
      },
    ];
  });
  const alwaysShown = rows.filter((row) => row.always).length;

  return (
    <>
      <Section
        title={t("settings.wheels.title")}
        error={error}
        sorting={sortable.sorting}
        note={t("settings.wheels.note")}
      >
        {rows.map((row, index) => (
          <Row
            key={row.key}
            label={row.label}
            hint={row.hint}
            icon={<ModeIcon mode={row.key} size={22} />}
            sortable={sortable.row(index)}
            handle={<DragHandle label={row.label} {...sortable.handle(index)} />}
          >
            {row.custom && (
              <button
                type="button"
                className="link-button"
                onClick={() => goTo("custom", row.key.slice("custom:".length))}
              >
                {t("settings.wheels.edit")}
              </button>
            )}
            <Toggle
              checked={row.enabled}
              label={row.label}
              // La dernière roue toujours affichée ne peut pas être désactivée
              disabled={row.always && alwaysShown === 1}
              onChange={row.toggle}
            />
          </Row>
        ))}
        <AddRow label={t("settings.wheels.create")} onClick={() => goTo("custom")} />
      </Section>

      <Section title={t("settings.wheels.behavior")}>
        <Row
          label={t("settings.wheels.dwell.label")}
          hint={t("settings.wheels.dwell.hint")}
        >
          <Slider
            label={t("settings.wheels.dwell.label")}
            value={settings.dwellMs}
            min={400}
            max={2500}
            step={100}
            showValue
            formatValue={(ms) =>
              t("settings.wheels.dwell.value", {
                seconds: (ms / 1000).toLocaleString(language(), { minimumFractionDigits: 1 }),
              })
            }
            onCommit={(dwellMs) => change("wheels", { dwellMs })}
          />
        </Row>
        <Row
          label={t("settings.wheels.remember.label")}
          hint={
            settings.rememberWheel
              ? t("settings.wheels.remember.on")
              : t("settings.wheels.remember.off")
          }
        >
          <Toggle
            checked={settings.rememberWheel}
            label={t("settings.wheels.remember.toggle")}
            onChange={(rememberWheel) => change("wheels", { rememberWheel })}
          />
        </Row>
        <Row
          label={t("settings.wheels.fileWheel.label")}
          hint={t("settings.wheels.fileWheel.hint", { summary: fileWheelsSummary(settings.fileWheels) })}
        >
          <button
            type="button"
            className="link-button"
            onClick={() => goTo("actions", FILE_WHEELS_ANCHOR)}
          >
            {t("settings.wheels.fileWheel.adjust")}
          </button>
        </Row>
      </Section>
    </>
  );
}
