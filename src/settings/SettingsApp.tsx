import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { GemIcon } from "../GemIcon";
import {
  getSettings,
  openPermissionSettings,
  setLaunchAtLogin,
  updateSettings,
  type Settings,
  type SettingsView,
} from "../ipc";
import { recordShortcut } from "./accelerator";
import "./settings.css";

type SectionId = "shortcut" | "shake" | "quality" | "startup";

// Aperçu dans un navigateur, sans Tauri
const PREVIEW: SettingsView = {
  settings: {
    shortcut: "CommandOrControl+Shift+Space",
    shakeEnabled: true,
    shakeSensitivity: 5,
    jpegQuality: 90,
    webpQuality: 85,
    avifQuality: 70,
  },
  shortcutLabel: "⌘⇧Espace",
  defaultShortcut: "CommandOrControl+Shift+Space",
  shortcutsSupported: true,
  wayland: false,
  launchAtLogin: false,
  finderPermission: "granted",
  platform: "macos",
  version: "0.1.0",
};

const PERMISSION_TEXT: Record<NonNullable<SettingsView["finderPermission"]>, string> = {
  granted: "Autorisée",
  denied: "Refusée",
  notAsked: "Demandée à la première utilisation",
  unknown: "Inconnue",
};

/** Les curseurs n'enregistrent qu'une fois relâchés depuis un court instant. */
const SLIDER_COMMIT_MS = 300;

export function SettingsApp() {
  const [view, setView] = useState<SettingsView | null>(isTauri() ? null : PREVIEW);
  const [errors, setErrors] = useState<Partial<Record<SectionId, string>>>({});

  useEffect(() => {
    if (isTauri()) void getSettings().then(setView);
  }, []);

  const save = useCallback(async (section: SectionId, settings: Settings) => {
    setErrors((current) => ({ ...current, [section]: undefined }));
    if (!isTauri()) {
      setView((current) => current && { ...current, settings });
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
  const isMac = view.platform === "macos";

  const toggleLaunchAtLogin = async (enabled: boolean) => {
    setErrors((current) => ({ ...current, startup: undefined }));
    try {
      const applied = isTauri() ? await setLaunchAtLogin(enabled) : enabled;
      setView({ ...view, launchAtLogin: applied });
    } catch (error) {
      setErrors((current) => ({ ...current, startup: String(error) }));
    }
  };

  return (
    <main className="settings-page">
      <header className="settings-header">
        <GemIcon size={40} />
        <div>
          <h1>Rutile</h1>
          <p>Convertisseur d'images à roue radiale · version {view.version}</p>
        </div>
      </header>

      <Section title="Ouvrir la roue" error={errors.shortcut}>
        {view.shortcutsSupported ? (
          <>
            <Row
              label="Raccourci clavier"
              hint={
                isMac
                  ? "Si une autre app utilise déjà ce raccourci, macOS la sert en premier."
                  : "Un nouvel appui referme la roue."
              }
            >
              <ShortcutRecorder
                label={view.shortcutLabel}
                modifiersHint={isMac ? "Ajoutez ⌘, ⌃, ⌥ ou ⇧." : "Ajoutez Ctrl, Alt ou Maj."}
                onRecord={(shortcut) => change("shortcut", { shortcut })}
              />
              {settings.shortcut !== view.defaultShortcut && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => change("shortcut", { shortcut: view.defaultShortcut })}
                >
                  Par défaut
                </button>
              )}
            </Row>
          </>
        ) : (
          <p className="section-note">
            Sous Wayland, les apps ne peuvent pas écouter le clavier. Liez la commande{" "}
            <code>rutile --open</code> à un raccourci du système : Paramètres → Clavier →
            Raccourcis personnalisés.
          </p>
        )}
      </Section>

      <Section title="Secouer un fichier" error={errors.shake}>
        <Row
          label="Ouvrir la roue en secouant un fichier glissé"
          hint={
            view.wayland
              ? "Demande d'être dans le groupe « input », qui donne aussi accès au clavier."
              : "Quelques allers-retours rapides pendant le glisser."
          }
        >
          <Toggle
            checked={settings.shakeEnabled}
            label="Secouage"
            onChange={(shakeEnabled) => change("shake", { shakeEnabled })}
          />
        </Row>
        <Row label="Sensibilité">
          <Slider
            label="Sensibilité du secouage"
            value={settings.shakeSensitivity}
            min={1}
            max={10}
            disabled={!settings.shakeEnabled}
            ends={["Franc", "Léger"]}
            onCommit={(shakeSensitivity) => change("shake", { shakeSensitivity })}
          />
        </Row>
      </Section>

      <Section title="Qualité des formats avec perte" error={errors.quality}>
        {(
          [
            ["JPEG", "jpegQuality"],
            ["WebP", "webpQuality"],
            ["AVIF", "avifQuality"],
          ] as const
        ).map(([label, key]) => (
          <Row key={key} label={label}>
            <Slider
              label={`Qualité ${label}`}
              value={settings[key]}
              min={1}
              max={100}
              showValue
              onCommit={(value) => change("quality", { [key]: value })}
            />
          </Row>
        ))}
        <p className="section-note">Plus la qualité est haute, plus le fichier est lourd.</p>
      </Section>

      <Section title="Démarrage" error={errors.startup}>
        <Row label="Lancer Rutile à l'ouverture de session">
          <Toggle
            checked={view.launchAtLogin}
            label="Lancement au démarrage"
            onChange={(enabled) => void toggleLaunchAtLogin(enabled)}
          />
        </Row>
      </Section>

      {view.finderPermission && (
        <Section title="Autorisations">
          <Row
            label="Lire la sélection du Finder"
            hint="Pour convertir le fichier sélectionné quand la roue s'ouvre."
          >
            <span className="status" data-state={view.finderPermission}>
              {PERMISSION_TEXT[view.finderPermission]}
            </span>
            {view.finderPermission === "denied" && (
              <button
                type="button"
                className="link-button"
                onClick={() => void openPermissionSettings()}
              >
                Ouvrir les réglages
              </button>
            )}
          </Row>
        </Section>
      )}
    </main>
  );
}

function Section({ title, error, children }: { title: string; error?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h2>{title}</h2>
      <div className="settings-card">{children}</div>
      {error && (
        <p className="section-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="row-text">
        <span className="row-label">{label}</span>
        {hint && <span className="row-hint">{hint}</span>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="toggle"
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  disabled,
  showValue,
  ends,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  showValue?: boolean;
  ends?: [string, string];
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setDraft(value), [value]);

  const update = (next: number) => {
    setDraft(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onCommit(next), SLIDER_COMMIT_MS);
  };

  return (
    <div className="slider" data-disabled={disabled}>
      {ends && <span className="slider-end">{ends[0]}</span>}
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        value={draft}
        disabled={disabled}
        style={{ "--fill": `${((draft - min) / (max - min)) * 100}%` } as React.CSSProperties}
        onChange={(event) => update(Number(event.target.value))}
      />
      {ends && <span className="slider-end">{ends[1]}</span>}
      {showValue && <span className="slider-value">{draft}</span>}
    </div>
  );
}

/** Bouton qui enregistre la combinaison pressée ; Échap annule. */
function ShortcutRecorder({
  label,
  modifiersHint,
  onRecord,
}: {
  label: string;
  modifiersHint: string;
  onRecord: (shortcut: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === "Escape") {
        setRecording(false);
        return;
      }
      const recorded = recordShortcut(event);
      if (recorded.kind === "waiting") return;
      if (recorded.kind === "needsModifier") {
        setHint(modifiersHint);
        return;
      }
      setRecording(false);
      onRecord(recorded.accelerator);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, onRecord, modifiersHint]);

  return (
    <div className="shortcut-recorder">
      <button
        type="button"
        className="shortcut-button"
        data-recording={recording}
        onClick={() => {
          setHint(null);
          setRecording(!recording);
        }}
      >
        {recording ? "Tapez le raccourci…" : label}
      </button>
      {recording && hint && <span className="row-hint">{hint}</span>}
    </div>
  );
}
