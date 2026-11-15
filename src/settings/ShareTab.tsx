import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { type MessageKey, language, t } from "../i18n";
import {
  pickApp,
  pickShareFolder,
  shareChoices,
  type Settings,
  type SettingsView,
  type ShareChoice,
  type ShareTarget,
} from "../ipc";
import { shareIcon } from "../wheel/formats";
import { MAX_SECTORS, SECTOR_COUNT } from "../wheel/geometry";
import { AddRow, type Change, DragHandle, type Errors, ItemIcon, Row, Section } from "./controls";
import { PREVIEW_CHOICES } from "./preview";
import { slotPosition, targetOf, WheelSwitch } from "./shared";
import { moved, useSortable } from "./useSortable";

/** Ce que fait une destination, sous son nom. */
const SHARE_KINDS: Record<ShareTarget["kind"], MessageKey> = {
  service: "settings.share.kind.service",
  folder: "settings.share.kind.folder",
  app: "settings.share.kind.app",
  system: "settings.share.kind.system",
};

export function ShareTab({ view, errors, change }: { view: SettingsView; errors: Errors; change: Change }) {
  const { settings } = view;
  // Part dont on choisit la destination
  const [picking, setPicking] = useState<number | null>(null);
  const paste = view.platform === "macos" ? "⌘V" : "Ctrl+V";

  const count = settings.share.length;
  const setShare = (share: Settings["share"]) => change("share", { share });
  const sortable = useSortable(count, (from, to) => setShare(moved(settings.share, from, to)));

  // `slot` égal au nombre d'emplacements : ajoute une part à la roue
  const setTarget = (slot: number, target: ShareTarget) => {
    const share = [...settings.share];
    share[slot] = target;
    setShare(share);
  };

  // Au-delà de six parts, retirer une destination retire sa part ; sinon la part reste, vide
  const remove = (slot: number) =>
    setShare(
      count > SECTOR_COUNT
        ? settings.share.filter((_, i) => i !== slot)
        : settings.share.map((target, i) => (i === slot ? null : target)),
    );

  return (
    <>
      <Section title={t("settings.share.wheel.title")} error={errors.wheels}>
        <WheelSwitch
          settings={settings}
          mode="share"
          label={t("settings.share.wheel.switch")}
          change={change}
        />
      </Section>
      <Section
        title={t("settings.share.title")}
        error={errors.share}
        sorting={sortable.sorting}
        note={t(view.platform === "macos" ? "settings.share.noteMac" : "settings.share.note", {
          paste,
        })}
      >
        {settings.share.map((_, slot) => {
          const target = view.share[slot];
          const position = slotPosition(slot, count);
          return (
            <Row
              key={slot}
              label={target ? target.name : t("settings.share.none")}
              hint={
                target
                  ? t("settings.share.slotHint", { position, kind: t(SHARE_KINDS[target.kind]) })
                  : position
              }
              muted={!target}
              icon={<ItemIcon icon={target && shareIcon(target)} name={target?.name} />}
              sortable={sortable.row(slot)}
              handle={<DragHandle label={target?.name ?? position} {...sortable.handle(slot)} />}
            >
              <button type="button" className="link-button" onClick={() => setPicking(slot)}>
                {target ? t("settings.common.change") : t("settings.common.choose")}
              </button>
              {(target || count > SECTOR_COUNT) && (
                <button type="button" className="link-button" onClick={() => remove(slot)}>
                  {t("settings.common.remove")}
                </button>
              )}
            </Row>
          );
        })}
        {count < MAX_SECTORS && (
          <AddRow label={t("settings.share.add")} onClick={() => setPicking(count)} />
        )}
      </Section>
      {picking !== null && (
        <SharePicker
          position={
            picking < count ? slotPosition(picking, count) : t("settings.common.newPart")
          }
          onPick={(target) => {
            setTarget(picking, target);
            setPicking(null);
          }}
          onCancel={() => setPicking(null)}
        />
      )}
    </>
  );
}

/** Feuille de choix d'une destination : services, dossiers synchronisés, messageries, ou
 * un dossier et une app quelconques. */
function SharePicker({
  position,
  onPick,
  onCancel,
}: {
  position: string;
  onPick: (target: ShareTarget) => void;
  onCancel: () => void;
}) {
  const [choices, setChoices] = useState<ShareChoice[] | null>(isTauri() ? null : PREVIEW_CHOICES);
  const sheet = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  // Lues une fois à l'ouverture : les icônes des services prennent un instant
  useEffect(() => {
    if (isTauri()) void shareChoices().then(setChoices);
    sheet.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const groups = new Map<string, ShareChoice[]>();
  for (const choice of choices ?? []) {
    groups.set(choice.group, [...(groups.get(choice.group) ?? []), choice]);
  }

  const pickFolder = async () => {
    const folder = isTauri() ? await pickShareFolder() : null;
    if (folder) onPick(targetOf(folder));
  };

  const pickMessagingApp = async () => {
    const app = isTauri() ? await pickApp() : null;
    if (app) onPick({ kind: "app", path: app.path, name: app.name });
  };

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div
        ref={sheet}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.share.sheet.aria", { position: position.toLocaleLowerCase(language()) })}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="sheet-title">
          {t("settings.share.sheet.title", { position: position.toLocaleLowerCase(language()) })}
        </h3>
        <div className="sheet-list">
          {choices === null && <p className="sheet-empty">{t("settings.share.sheet.searching")}</p>}
          {[...groups].map(([group, items]) => (
            <div key={group} className="sheet-group">
              <h4>{group}</h4>
              {items.map((choice) => (
                <button
                  key={
                    choice.kind === "service"
                      ? choice.id
                      : choice.kind === "system"
                        ? "system"
                        : choice.path
                  }
                  type="button"
                  className="sheet-item"
                  onClick={() => onPick(targetOf(choice))}
                >
                  <ItemIcon icon={shareIcon(choice)} name={choice.name} small />
                  <span>{choice.name}</span>
                </button>
              ))}
            </div>
          ))}
          <div className="sheet-group">
            <h4>{t("settings.share.sheet.misc")}</h4>
            <button type="button" className="sheet-item" onClick={() => void pickFolder()}>
              <span className="sheet-item-glyph" aria-hidden="true">
                ⌂
              </span>
              <span>{t("settings.share.sheet.folder")}</span>
            </button>
            <button type="button" className="sheet-item" onClick={() => void pickMessagingApp()}>
              <span className="sheet-item-glyph" aria-hidden="true">
                ✉
              </span>
              <span>{t("settings.share.sheet.messaging")}</span>
            </button>
          </div>
        </div>
        <div className="sheet-actions">
          <button type="button" className="shortcut-button" onClick={onCancel}>
            {t("settings.common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
