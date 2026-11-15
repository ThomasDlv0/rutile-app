import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { GemIcon } from "../GemIcon";
import { type MessageKey, t } from "../i18n";
import { closeWelcome, getSettings, type SettingsView } from "../ipc";
import { PREVIEW } from "../settings/preview";
import "../update/update.css";
import "./welcome.css";

const TRAY: Record<string, MessageKey> = {
  macos: "welcome.tray.macos",
  windows: "welcome.tray.windows",
  linux: "welcome.tray.linux",
};

/** Fenêtre d'accueil, au premier lancement : comment ouvrir la roue et où sont les réglages. */
export function WelcomeApp() {
  const [view, setView] = useState<SettingsView | null>(isTauri() ? null : PREVIEW);
  useEffect(() => {
    if (isTauri()) void getSettings().then(setView);
  }, []);
  if (!view) return <div className="update-page welcome-page" />;
  const { platform } = view;
  const finish = (tryWheel: boolean) => {
    if (isTauri()) void closeWelcome(tryWheel);
  };

  return (
    <div className="update-page welcome-page" data-platform={platform} data-preview={!isTauri() || undefined}>
      <header className="update-hero">
        <div className="update-logo">
          <span className="update-logo-glow" aria-hidden="true" />
          <GemIcon size={68} />
        </div>
        <h1 className="update-title">{t("welcome.title")}</h1>
        <p className="update-subtitle">{t("welcome.subtitle")}</p>
      </header>

      <ul className="welcome-steps">
        <li>
          <span className="welcome-key">{view.shortcutLabel}</span>
          <span>{t("welcome.shortcut")}</span>
        </li>
        <li>
          <Glyph d="M7 8.5 10 5.5l3 3M10 5.5V14M4.5 10.5c-1 1.3-1 3 0 4.2M15.5 10.5c1 1.3 1 3 0 4.2" />
          <span>{t("welcome.shake")}</span>
        </li>
        <li>
          <Glyph d="M10 3.2a6.8 6.8 0 1 0 0 13.6 6.8 6.8 0 0 0 0-13.6ZM10 7.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z" />
          <span>{t("welcome.center")}</span>
        </li>
        <li>
          <Glyph d="M3 5.5h14M3 10h14M3 14.5h14M12.5 3.6v3.8M6.5 8.1v3.8M11 12.6v3.8" />
          <span>{t(TRAY[platform] ?? "welcome.tray.linux")}</span>
        </li>
      </ul>

      {platform === "macos" && <p className="update-footnote">{t("welcome.permissions")}</p>}

      <div className="update-actions">
        <button type="button" className="update-button" onClick={() => finish(false)}>
          {t("welcome.later")}
        </button>
        <button type="button" className="update-button" data-primary onClick={() => finish(true)}>
          {t("welcome.try")}
        </button>
      </div>
    </div>
  );
}

/** Pictogramme au trait d'une étape, dans la couleur du texte. */
function Glyph({ d }: { d: string }) {
  return (
    <svg className="welcome-glyph" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
