import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { GemIcon } from "../GemIcon";
import { type MessageKey, t, useLanguage } from "../i18n";
import {
  SETTINGS_REFRESH_EVENT,
  SETTINGS_TAB_EVENT,
  getSettings,
  updateSettings,
  type Settings,
  type SettingsTab,
  type SettingsView,
} from "../ipc";
import { ActionsTab } from "./ActionsTab";
import { AppsTab } from "./AppsTab";
import { BubbleGroup } from "./Bubble";
import { ColorsTab } from "./ColorsTab";
import type { SectionId } from "./controls";
import { ConversionTab } from "./ConversionTab";
import { CustomTab } from "./CustomTab";
import { GeneralTab } from "./GeneralTab";
import { viewsOf } from "./parts";
import { PREVIEW } from "./preview";
import { ShareTab } from "./ShareTab";
import { WheelsTab } from "./WheelsTab";
import "./settings.css";

const TABS: { id: SettingsTab; label: MessageKey }[] = [
  { id: "general", label: "settings.tabs.general" },
  { id: "wheels", label: "settings.tabs.wheels" },
  { id: "conversion", label: "settings.tabs.conversion" },
  { id: "colors", label: "settings.tabs.colors" },
  { id: "actions", label: "settings.tabs.actions" },
  { id: "apps", label: "settings.tabs.apps" },
  { id: "share", label: "settings.tabs.share" },
  { id: "custom", label: "settings.tabs.custom" },
];

export function SettingsApp() {
  // Un nouveau rendu à chaque changement de langue, pour toute la fenêtre
  useLanguage();
  const [view, setView] = useState<SettingsView | null>(isTauri() ? null : PREVIEW);
  const [tab, setTab] = useState<SettingsTab>("general");
  // Partie de l'onglet à montrer, quand on y arrive depuis un autre
  const [anchor, setAnchor] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<SectionId, string>>>({});

  useEffect(() => {
    if (!isTauri()) return;
    void getSettings().then((loaded) => {
      setView(loaded);
      if (loaded.tab) setTab(loaded.tab);
    });
    // Une part vide de la roue ramène la fenêtre déjà ouverte sur le bon onglet
    const onTab = listen<SettingsTab>(SETTINGS_TAB_EVENT, ({ payload }) => setTab(payload));
    // Le logo d'un site arrive après coup : les icônes sont relues
    const onRefresh = listen(SETTINGS_REFRESH_EVENT, () => void getSettings().then(setView));
    return () => {
      void onTab.then((stop) => stop());
      void onRefresh.then((stop) => stop());
    };
  }, []);

  const goTo = useCallback((next: SettingsTab, target?: string) => {
    setTab(next);
    setAnchor(target ?? null);
  }, []);
  useEffect(() => {
    const target = anchor && document.getElementById(anchor);
    if (target) target.scrollIntoView({ block: "start" });
    else window.scrollTo({ top: 0 });
  }, [tab, anchor]);

  // Le nouvel onglet arrive du côté où il se trouve dans la barre
  const shownTab = useRef(tab);
  const direction = useRef<"forward" | "back">("forward");
  if (shownTab.current !== tab) {
    const index = (id: SettingsTab) => TABS.findIndex((known) => known.id === id);
    direction.current = index(tab) > index(shownTab.current) ? "forward" : "back";
    shownTab.current = tab;
  }

  // Un nom d'onglet trop long pour cette langue ou cette police : toute la barre se resserre,
  // plutôt que de couper les noms
  const loaded = view !== null;
  useLayoutEffect(() => {
    const nav = document.querySelector<HTMLElement>(".settings-tabs");
    if (!nav) return;
    const fit = () => {
      delete nav.dataset.compact;
      const cut = [...nav.querySelectorAll<HTMLElement>(".settings-tab span")].some(
        (label) => label.scrollWidth > label.clientWidth + 0.5,
      );
      if (cut) nav.dataset.compact = "true";
    };
    fit();
    // Une police chargée après coup peut changer la largeur des noms
    void document.fonts?.ready.then(fit);
  }, [loaded]);

  const save = useCallback(async (section: SectionId, settings: Settings) => {
    setErrors((current) => ({ ...current, [section]: undefined }));
    if (!isTauri()) {
      // Aperçu dans un navigateur : ce que Rust renverrait, les icônes en moins
      setView(
        (current) =>
          current && {
            ...current,
            settings,
            apps: settings.apps.map((slot) => slot && { ...slot, icon: null }),
            share: settings.share.map((target) => target && { ...target, icon: null }),
          },
      );
      return;
    }
    try {
      setView(await updateSettings(settings));
    } catch (error) {
      setErrors((current) => ({ ...current, [section]: String(error) }));
      // Rust a gardé l'ancienne valeur : on réaffiche ce qui est réellement appliqué
      setView(await getSettings());
    }
  }, []);

  if (!view) return <div className="settings-page" />;
  const { settings } = view;
  const change = (section: SectionId, patch: Partial<Settings>) =>
    void save(section, { ...settings, ...patch });
  // Dans un navigateur, Rust n'est pas là pour décrire les roues personnalisées
  const custom = isTauri() ? view.custom : viewsOf(settings.customWheels);

  return (
    <main className="settings-page">
      <header className="settings-header">
        <GemIcon size={40} />
        <div>
          <h1>Rutile</h1>
          <p>{t("settings.header.tagline", { version: view.version })}</p>
        </div>
      </header>

      <BubbleGroup as="nav" className="settings-tabs" role="tablist" label={t("settings.tabs.aria")} selected={tab}>
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="settings-tab"
            aria-selected={tab === id}
            onClick={() => goTo(id)}
          >
            <TabIcon tab={id} />
            <span>{t(label)}</span>
          </button>
        ))}
      </BubbleGroup>

      <div
        key={tab}
        className="settings-panel"
        data-direction={direction.current}
        role="tabpanel"
        aria-label={t(TABS.find(({ id }) => id === tab)?.label ?? "settings.tabs.general")}
      >
        {tab === "general" && (
          <GeneralTab view={view} errors={errors} setErrors={setErrors} setView={setView} change={change} />
        )}
        {tab === "wheels" && (
          <WheelsTab settings={settings} error={errors.wheels} change={change} goTo={goTo} />
        )}
        {tab === "conversion" && (
          <ConversionTab settings={settings} error={errors.quality} change={change} />
        )}
        {tab === "apps" && <AppsTab view={view} errors={errors} change={change} />}
        {tab === "colors" && (
          <ColorsTab view={view} custom={custom} error={errors.colors} change={change} goTo={goTo} />
        )}
        {tab === "actions" && <ActionsTab view={view} errors={errors} change={change} />}
        {tab === "share" && <ShareTab view={view} errors={errors} change={change} />}
        {tab === "custom" && (
          <CustomTab
            // Arriver depuis « Modifier » ouvre directement cette roue
            key={anchor ?? ""}
            view={view}
            custom={custom}
            openWheel={anchor}
            error={errors.custom}
            change={change}
          />
        )}
      </div>
    </main>
  );
}

/** Icônes des onglets, au trait, dans la couleur du texte. */
function TabIcon({ tab }: { tab: SettingsTab }) {
  const paths: Record<SettingsTab, ReactNode> = {
    general: (
      <>
        <path d="M3 5.5h14M3 10h14M3 14.5h14" />
        <circle cx="12.5" cy="5.5" r="1.9" className="tab-icon-knob" />
        <circle cx="6.5" cy="10" r="1.9" className="tab-icon-knob" />
        <circle cx="11" cy="14.5" r="1.9" className="tab-icon-knob" />
      </>
    ),
    wheels: (
      <>
        <circle cx="10" cy="10" r="7.2" />
        <circle cx="10" cy="10" r="2.6" />
        {[0, 60, 120, 180, 240, 300].map((angle) => {
          const radians = ((angle - 90) * Math.PI) / 180;
          return (
            <line
              key={angle}
              x1={10 + 2.6 * Math.cos(radians)}
              y1={10 + 2.6 * Math.sin(radians)}
              x2={10 + 7.2 * Math.cos(radians)}
              y2={10 + 7.2 * Math.sin(radians)}
            />
          );
        })}
      </>
    ),
    conversion: <path d="M4 7h11.5l-3-3M16 13H4.5l3 3" />,
    colors: (
      <>
        <path d="M10 2.8a7.2 7.2 0 1 0 0 14.4c1.2 0 1.6-.9 1.2-1.8-.5-1.1.2-2.2 1.4-2.2h1.6a3 3 0 0 0 3-3A7.4 7.4 0 0 0 10 2.8Z" />
        <circle cx="6.4" cy="9.2" r="1.1" className="tab-icon-dot" />
        <circle cx="9.2" cy="6.2" r="1.1" className="tab-icon-dot" />
        <circle cx="13" cy="7" r="1.1" className="tab-icon-dot" />
      </>
    ),
    actions: <path d="M11.4 2.6 4.3 11a.6.6 0 0 0 .5 1H9l-1 5.4 7-8.5a.6.6 0 0 0-.5-1h-4.1Z" />,
    apps: (
      <>
        <rect x="3.2" y="3.2" width="5.6" height="5.6" rx="1.6" />
        <rect x="11.2" y="3.2" width="5.6" height="5.6" rx="1.6" />
        <rect x="3.2" y="11.2" width="5.6" height="5.6" rx="1.6" />
        <rect x="11.2" y="11.2" width="5.6" height="5.6" rx="1.6" />
      </>
    ),
    share: <path d="M7 8.5H5.5a1 1 0 0 0-1 1V16a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9.5a1 1 0 0 0-1-1H13M10 2.8V12M6.8 6 10 2.8 13.2 6" />,
    custom: (
      <>
        <circle cx="9" cy="11" r="6.2" />
        <circle cx="9" cy="11" r="2" />
        <path d="M9 4.8V9M9 13v4.2M2.8 11H7M11 11h4.2M16 1.6v4.6M13.7 3.9h4.6" />
      </>
    ),
  };
  return (
    <svg className="tab-icon" width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
      {paths[tab]}
    </svg>
  );
}
