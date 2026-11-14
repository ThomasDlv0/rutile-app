import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setLanguage, useLanguage } from "./i18n";
import { SettingsApp } from "./settings/SettingsApp";
import { UpdateApp } from "./update/UpdateApp";
import { WheelApp } from "./wheel/WheelApp";
import "./styles.css";

// Une même page pour les trois fenêtres ; dans un navigateur, `?view=settings` montre les
// réglages, `?view=update` la fenêtre de mise à jour, et `?lang=en` change de langue
const query = new URLSearchParams(window.location.search);
const view = isTauri() ? getCurrentWindow().label : query.get("view");
if (view === "settings" || view === "update") document.documentElement.classList.add(view);

/** Langue changée dans les réglages (`LANGUAGE_EVENT` de settings.rs). */
const LANGUAGE_EVENT = "app://language";

function Root() {
  const language = useLanguage();
  if (view === "settings") {
    // Les réglages se refont entièrement dans la nouvelle langue : leurs listes sont
    // calculées une fois
    return <SettingsApp key={language} />;
  }
  return view === "update" ? <UpdateApp /> : <WheelApp />;
}

async function start() {
  // La langue est connue avant le premier rendu, pour ne jamais montrer le français par erreur
  if (isTauri()) {
    setLanguage(await invoke<string>("app_language").catch(() => "fr"));
    void listen<string>(LANGUAGE_EVENT, ({ payload }) => setLanguage(payload));
  } else {
    setLanguage(query.get("lang") ?? navigator.language);
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}

void start();
