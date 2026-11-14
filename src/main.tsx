import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SettingsApp } from "./settings/SettingsApp";
import { UpdateApp } from "./update/UpdateApp";
import { WheelApp } from "./wheel/WheelApp";
import "./styles.css";

// Une même page pour les trois fenêtres ; dans un navigateur, `?view=settings` montre les
// réglages et `?view=update` la fenêtre de mise à jour
const view = isTauri()
  ? getCurrentWindow().label
  : new URLSearchParams(window.location.search).get("view");
if (view === "settings" || view === "update") document.documentElement.classList.add(view);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {view === "settings" ? <SettingsApp /> : view === "update" ? <UpdateApp /> : <WheelApp />}
  </StrictMode>,
);
