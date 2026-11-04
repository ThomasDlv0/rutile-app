import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SettingsApp } from "./settings/SettingsApp";
import { WheelApp } from "./wheel/WheelApp";
import "./styles.css";

// Une même page pour les deux fenêtres ; dans un navigateur, `?view=settings` montre les réglages
const view = isTauri()
  ? getCurrentWindow().label
  : new URLSearchParams(window.location.search).get("view");
const isSettings = view === "settings";
if (isSettings) document.documentElement.classList.add("settings");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isSettings ? <SettingsApp /> : <WheelApp />}</StrictMode>,
);
