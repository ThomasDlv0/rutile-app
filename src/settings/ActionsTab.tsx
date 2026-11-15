import { Fragment, useState } from "react";
import { t } from "../i18n";
import {
  openPermissionSettings,
  type FileKind,
  type FirstWheel,
  type PartEntry,
  type SettingsView,
} from "../ipc";
import {
  type ActionNode,
  type Arranged,
  FILE_ACTIONS,
  FILE_KIND_LABELS,
  actionCatalog,
  arrange,
  partEntries,
} from "../wheel/actions";
import type { BuiltinMode } from "../wheel/formats";
import { BubbleGroup } from "./Bubble";
import { type Change, DragHandle, type Errors, Row, Section, Toggle } from "./controls";
import { PartChip } from "./parts";
import { FILE_WHEELS_ANCHOR, WheelSwitch, FILE_KINDS, DockBadgesRow } from "./shared";
import { moved, useSortable } from "./useSortable";

/** Lignes d'une liste de parts qu'on réordonne en glissant et qu'on affiche ou masque. Au
 * moins une part reste affichée. */
function usePartRows(
  parts: readonly Arranged<ActionNode>[],
  colors: Record<string, string>,
  onChange: (entries: PartEntry[]) => void,
) {
  const sortable = useSortable(parts.length, (from, to) =>
    onChange(partEntries(moved(parts, from, to))),
  );
  const shown = parts.filter(({ enabled }) => enabled).length;
  const rows = parts.map(({ item, enabled }, index) => (
    <Row
      key={item.id}
      label={item.label}
      hint={item.action}
      icon={<PartChip node={item} colors={colors} />}
      muted={!enabled}
      sortable={sortable.row(index)}
      handle={<DragHandle label={item.label} {...sortable.handle(index)} />}
    >
      <Toggle
        checked={enabled}
        label={t("settings.actions.showPart", { part: item.label })}
        disabled={enabled && shown === 1}
        onChange={(next) =>
          onChange(
            partEntries(parts.map((part, i) => (i === index ? { ...part, enabled: next } : part))),
          )
        }
      />
    </Row>
  ));
  return { rows, sorting: sortable.sorting };
}

/** Ce que propose le menu « S'ouvre sur », selon le type de fichier. */
function firstChoices(
  kind: FileKind,
): { id: FirstWheel; label: string; mode: BuiltinMode | null }[] {
  const convert =
    kind === "images"
      ? [{ id: "convert" as const, label: t("settings.mode.image"), mode: "image" as const }]
      : kind === "videos"
        ? [
            {
              id: "convert" as const,
              label: t("settings.actions.first.converterVideo"),
              mode: "video" as const,
            },
          ]
        : [];
  return [
    ...convert,
    { id: "actions", label: t("settings.actions.first.actions"), mode: "actions" },
    { id: "share", label: t("settings.mode.share"), mode: "share" },
    { id: "apps", label: t("settings.actions.first.apps"), mode: "apps" },
    { id: "usual", label: t("settings.actions.first.usual"), mode: null },
  ];
}

/** D'où viennent les fichiers sélectionnés, selon le système. */
const fileManager = (platform: string) =>
  t(
    platform === "macos"
      ? "settings.actions.manager.macos"
      : platform === "windows"
        ? "settings.actions.manager.windows"
        : "settings.actions.manager.default",
  );

export function ActionsTab({ view, errors, change }: { view: SettingsView; errors: Errors; change: Change }) {
  const { settings } = view;
  const colors = settings.formatColors;

  const windowLayout = view.platform !== "linux" || !view.wayland;
  const rootParts = arrange(actionCatalog({ windowLayout }), settings.actionParts);
  const root = usePartRows(rootParts, colors, (actionParts) => change("actions", { actionParts }));

  const [kind, setKind] = useState<FileKind>("images");
  const fileWheel = settings.fileWheels[kind];
  const setFileWheel = (next: Partial<typeof fileWheel>) =>
    change("actions", {
      fileWheels: { ...settings.fileWheels, [kind]: { ...fileWheel, ...next } },
    });
  const fileParts = arrange(FILE_ACTIONS[kind], fileWheel.parts);
  const forFiles = usePartRows(fileParts, colors, (parts) => setFileWheel({ parts }));
  const choices = firstChoices(kind);
  const chosen = choices.find(({ id }) => id === fileWheel.first) ?? choices[choices.length - 1];
  const chosenOff =
    chosen.mode !== null &&
    !settings.modes.some((entry) => entry.id === chosen.mode && entry.enabled);

  return (
    <>
      <Section
        title={t("settings.actions.root.title")}
        error={errors.wheels}
        sorting={root.sorting}
        note={t("settings.actions.root.note")}
      >
        <WheelSwitch settings={settings} mode="actions" label={t("settings.actions.root.switch")} change={change} />
        {root.rows}
      </Section>

      <Section
        id={FILE_WHEELS_ANCHOR}
        title={t("settings.actions.files.title")}
        error={errors.actions}
        sorting={forFiles.sorting}
        note={t("settings.actions.files.note", { manager: fileManager(view.platform) })}
      >
        <div className="kind-switch">
          <BubbleGroup
            className="segmented segmented-fill"
            role="tablist"
            label={t("settings.actions.files.kind")}
            selected={kind}
          >
            {FILE_KINDS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={kind === id}
                onClick={() => setKind(id)}
              >
                {FILE_KIND_LABELS[id]}
              </button>
            ))}
          </BubbleGroup>
        </div>
        <Row
          label={t("settings.actions.files.opensOn")}
          hint={
            chosenOff
              ? t("settings.actions.files.opensOnOff")
              : t("settings.actions.files.opensOnHint")
          }
        >
          <select
            className="text-input"
            aria-label={t("settings.actions.files.opensOnAria")}
            value={chosen.id}
            onChange={(event) => setFileWheel({ first: event.target.value as FirstWheel })}
          >
            {choices.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Row>
        {/* Remontées à chaque type : un interrupteur ne glisse pas d'un type à l'autre */}
        <Fragment key={kind}>{forFiles.rows}</Fragment>
      </Section>

      <Section title={t("settings.actions.capture.title")}>
        <Row
          label={t("settings.actions.capture.reopen")}
          hint={t("settings.actions.capture.reopenHint")}
        >
          <Toggle
            checked={settings.captureReopen}
            label={t("settings.actions.capture.reopen")}
            onChange={(captureReopen) => change("actions", { captureReopen })}
          />
        </Row>
        {view.platform === "macos" && (
          <Row
            label={t("settings.actions.capture.read")}
            hint={t("settings.actions.capture.readHint")}
          >
            <button
              type="button"
              className="link-button"
              onClick={() => void openPermissionSettings("screen")}
            >
              {t("settings.common.openSettings")}
            </button>
          </Row>
        )}
        {view.dockAccess !== null && (
          <DockBadgesRow
            allowed={view.dockAccess}
            label={t("settings.actions.capture.arrange")}
            hint={t("settings.actions.capture.arrangeHint")}
          />
        )}
      </Section>

    </>
  );
}
