import { useState } from "react";
import { type MessageKey, t } from "../i18n";
import type { AppKind, CustomPart, Settings, SettingsView } from "../ipc";
import { WEB_ICON } from "../wheel/formats";
import { MAX_SECTORS, SECTOR_COUNT } from "../wheel/geometry";
import { AddRow, type Change, DragHandle, type Errors, ItemIcon, Row, Section } from "./controls";
import { PartPicker } from "./PartPicker";
import { slotPosition, WheelSwitch, DockBadgesRow } from "./shared";
import { moved, useSortable } from "./useSortable";

/** Ce que devient une part qui n'ouvre pas une app. */
const SLOT_KINDS: Record<Exclude<AppKind, "app">, MessageKey> = {
  folder: "settings.kind.folder",
  url: "settings.kind.url",
};

/** Ce qu'on peut poser sur la roue des apps. */
const APP_KINDS = ["app", "folder", "url"] as const;

export function AppsTab({ view, errors, change }: { view: SettingsView; errors: Errors; change: Change }) {
  const { settings } = view;
  const count = settings.apps.length;
  const setApps = (apps: Settings["apps"]) => change("apps", { apps });
  const sortable = useSortable(count, (from, to) => setApps(moved(settings.apps, from, to)));
  // Part dont on choisit le contenu ; égale au nombre de parts, elle s'ajoute à la roue
  const [picking, setPicking] = useState<number | null>(null);
  const free = settings.apps.indexOf(null);

  const place = (slot: number, part: CustomPart) => {
    const apps = [...settings.apps];
    apps[slot] = { path: part.value, name: part.name, kind: part.kind as AppKind };
    setApps(apps);
  };

  // Au-delà de six parts, retirer une app retire sa part ; sinon la part reste, vide
  const remove = (slot: number) =>
    setApps(
      count > SECTOR_COUNT
        ? settings.apps.filter((_, i) => i !== slot)
        : settings.apps.map((app, i) => (i === slot ? null : app)),
    );
  const replaced = picking === null ? null : (settings.apps[picking] ?? null);

  return (
    <>
      <Section title={t("settings.apps.wheel.title")} error={errors.wheels}>
        <WheelSwitch settings={settings} mode="apps" label={t("settings.apps.wheel.switch")} change={change} />
      </Section>
      <Section
        title={t("settings.apps.title")}
        error={errors.apps}
        sorting={sortable.sorting}
        note={t(view.platform === "macos" ? "settings.apps.noteMac" : "settings.apps.note", {
          min: SECTOR_COUNT,
          max: MAX_SECTORS,
        })}
      >
        {settings.apps.map((_, slot) => {
          const app = view.apps[slot];
          const position = slotPosition(slot, count);
          return (
            <Row
              key={slot}
              label={app ? app.name : t("settings.apps.none")}
              hint={
                app && app.kind !== "app"
                  ? t("settings.apps.slotHint", { kind: t(SLOT_KINDS[app.kind]), position })
                  : position
              }
              muted={!app}
              // Un site dont le logo n'est pas (encore) connu garde le globe, comme sur la roue
              icon={
                <ItemIcon
                  icon={app?.icon ?? (app?.kind === "url" ? WEB_ICON : undefined)}
                  name={app?.name}
                />
              }
              sortable={sortable.row(slot)}
              handle={<DragHandle label={app?.name ?? position} {...sortable.handle(slot)} />}
            >
              <button type="button" className="link-button" onClick={() => setPicking(slot)}>
                {app ? t("settings.common.change") : t("settings.common.choose")}
              </button>
              {(app || count > SECTOR_COUNT) && (
                <button type="button" className="link-button" onClick={() => remove(slot)}>
                  {t("settings.common.remove")}
                </button>
              )}
            </Row>
          );
        })}
        {(free >= 0 || count < MAX_SECTORS) && (
          // Dans la première part libre, ou une part de plus
          <AddRow label={t("settings.common.addPart")} onClick={() => setPicking(free >= 0 ? free : count)} />
        )}
      </Section>
      {view.dockAccess !== null && (
        <Section title={t("settings.apps.badges.title")}>
          <DockBadgesRow allowed={view.dockAccess} />
        </Section>
      )}
      {picking !== null && (
        <PartPicker
          title={replaced ? t("settings.apps.changeTitle", { name: replaced.name }) : t("settings.common.newPart")}
          kinds={APP_KINDS}
          current={replaced && { kind: replaced.kind, name: replaced.name, value: replaced.path }}
          colors={settings.formatColors}
          windowLayout
          onPick={(part) => {
            place(picking, part);
            setPicking(null);
          }}
          onCancel={() => setPicking(null)}
        />
      )}
    </>
  );
}
