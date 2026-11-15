/** Morceaux des réglages partagés par plusieurs onglets. */

import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { type MessageKey, t } from "../i18n";
import {
  allowDockBadges,
  dockBadgesAllowed,
  openPermissionSettings,
  type FileKind,
  type Settings,
  type ShareTarget,
  type ShareView,
} from "../ipc";
import { FILE_KIND_LABELS } from "../wheel/actions";
import type { BuiltinMode } from "../wheel/formats";
import { ModeIcon } from "../wheel/Wheel";
import { type Change, Row, Toggle } from "./controls";

/** Dans l'onglet Actions : ce qu'ouvre un fichier selon son type. */
export const FILE_WHEELS_ANCHOR = "selon-le-fichier";

const DIRECTIONS: MessageKey[] = [
  "settings.direction.top",
  "settings.direction.topRight",
  "settings.direction.right",
  "settings.direction.bottomRight",
  "settings.direction.bottom",
  "settings.direction.bottomLeft",
  "settings.direction.left",
  "settings.direction.topLeft",
];

/** Où se trouve la part `index` d'une roue de `count` parts, dans le sens horaire depuis le
 * haut. */
export function slotPosition(index: number, count: number): string {
  return t(DIRECTIONS[Math.round((index * 8) / count) % 8]);
}

/** Destination à enregistrer, sans ce qui ne sert qu'à l'affichage. */
export function targetOf(view: ShareView): ShareTarget {
  switch (view.kind) {
    case "service":
      return { kind: "service", id: view.id, name: view.name };
    case "folder":
      return { kind: "folder", path: view.path, name: view.name };
    case "app":
      return { kind: "app", path: view.path, name: view.name };
    case "system":
      return { kind: "system", name: view.name };
  }
}

export function withMode(settings: Settings, mode: BuiltinMode, enabled: boolean): Settings["modes"] {
  return settings.modes.map((entry) => (entry.id === mode ? { ...entry, enabled } : entry));
}

/** Interrupteur d'une roue, en tête de son onglet. */
export function WheelSwitch({
  settings,
  mode,
  label,
  change,
}: {
  settings: Settings;
  mode: BuiltinMode;
  label: string;
  change: Change;
}) {
  const enabled = settings.modes.some((entry) => entry.id === mode && entry.enabled);
  // Une roue personnalisée toujours affichée peut rester la seule
  const others =
    settings.modes.filter((entry) => entry.enabled && entry.id !== mode).length +
    settings.customWheels.filter(
      (wheel) => wheel.enabled && wheel.parts.length > 0 && wheel.extensions.length === 0,
    ).length;
  const onlyOne = others === 0;
  return (
    <Row
      label={label}
      icon={<ModeIcon mode={mode} size={22} />}
      hint={enabled ? t("settings.wheels.switch.on") : t("settings.wheels.switch.off")}
    >
      <Toggle
        checked={enabled}
        label={label}
        disabled={enabled && onlyOne}
        onChange={(next) => change("wheels", { modes: withMode(settings, mode, next) })}
      />
    </Row>
  );
}

export const FILE_KINDS = Object.keys(FILE_KIND_LABELS) as FileKind[];

/** macOS : les pastilles des apps ouvertes se lisent sans autorisation ; celles que le Dock
 * garde pour les apps fermées demandent l'autorisation Accessibilité. */
export function DockBadgesRow({
  allowed: initial,
  label = t("settings.apps.badges.label"),
  hint = t("settings.apps.badges.hint"),
}: {
  allowed: boolean;
  label?: string;
  hint?: string;
}) {
  const [allowed, setAllowed] = useState(initial);
  // Demandée une fois : si macOS ne la propose plus, il reste les Réglages Système
  const [asked, setAsked] = useState(false);

  // De retour des Réglages Système, l'autorisation a pu changer
  useEffect(() => {
    if (!isTauri()) return;
    const refresh = () => void dockBadgesAllowed().then((value) => setAllowed(value === true));
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const ask = async () => {
    setAsked(true);
    setAllowed(isTauri() ? await allowDockBadges() : false);
  };

  return (
    <Row label={label} hint={hint}>
      {allowed ? (
        <span className="status" data-state="granted">
          {t("settings.permission.granted")}
        </span>
      ) : asked ? (
        <button
          type="button"
          className="link-button"
          onClick={() => void openPermissionSettings("accessibility")}
        >
          {t("settings.common.openSettings")}
        </button>
      ) : (
        <button type="button" className="link-button" onClick={() => void ask()}>
          {t("settings.apps.badges.allow")}
        </button>
      )}
    </Row>
  );
}
