import { useEffect, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LANGUAGES, type MessageKey, languageName, setLanguage, t } from "../i18n";
import {
  UPDATE_PROGRESS_EVENT,
  checkUpdate,
  installUpdate,
  openPermissionSettings,
  setLaunchAtLogin,
  type SettingsView,
  type UpdateStatus,
} from "../ipc";
import { recordShortcut } from "./accelerator";
import { type Change, type Errors, Row, Section, Slider, Toggle } from "./controls";

const PERMISSION_TEXT: Record<NonNullable<SettingsView["finderPermission"]>, MessageKey> = {
  granted: "settings.permission.granted",
  denied: "settings.permission.denied",
  notAsked: "settings.permission.notAsked",
  unknown: "settings.permission.unknown",
};

/** Marque la place d'un fragment de code dans un texte traduit. */
const CODE_MARK = "\u0001";

/** Le texte traduit, `code` en police de code à la place de la marque. */
function withCode(text: string, code: string): ReactNode {
  const [before, after = ""] = text.split(CODE_MARK);
  return (
    <>
      {before}
      <code>{code}</code>
      {after}
    </>
  );
}

export function GeneralTab({
  view,
  errors,
  setErrors,
  setView,
  change,
}: {
  view: SettingsView;
  errors: Errors;
  setErrors: (update: (current: Errors) => Errors) => void;
  setView: (view: SettingsView) => void;
  change: Change;
}) {
  const { settings } = view;
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
    <>
      <LanguageSection view={view} error={errors.language} change={change} />

      <Section
        title={t("settings.general.open.title")}
        error={errors.shortcut}
        note={t("settings.general.open.note")}
      >
        {view.shortcutsSupported ? (
          <Row
            label={t("settings.general.shortcut.label")}
            hint={
              isMac
                ? t("settings.general.shortcut.hintMac")
                : t("settings.general.shortcut.hintOther")
            }
          >
            <ShortcutRecorder
              label={view.shortcutLabel}
              modifiersHint={t(isMac ? "settings.general.shortcut.modifiersMac" : "settings.general.shortcut.modifiersOther")}
              onRecord={(shortcut) => change("shortcut", { shortcut })}
            />
            {settings.shortcut !== view.defaultShortcut && (
              <button
                type="button"
                className="link-button"
                onClick={() => change("shortcut", { shortcut: view.defaultShortcut })}
              >
                {t("settings.general.shortcut.default")}
              </button>
            )}
          </Row>
        ) : (
          <p className="section-note">{withCode(t("settings.general.shortcut.wayland", { command: CODE_MARK }), "rutile --open")}</p>
        )}
      </Section>

      <Section title={t("settings.general.shake.title")} error={errors.shake}>
        <Row
          label={t("settings.general.shake.label")}
          hint={
            view.wayland
              ? t("settings.general.shake.hintWayland")
              : t("settings.general.shake.hint")
          }
        >
          <Toggle
            checked={settings.shakeEnabled}
            label={t("settings.general.shake.toggle")}
            onChange={(shakeEnabled) => change("shake", { shakeEnabled })}
          />
        </Row>
        <Row label={t("settings.general.shake.sensitivity")}>
          <Slider
            label={t("settings.general.shake.sensitivityAria")}
            value={settings.shakeSensitivity}
            min={1}
            max={10}
            disabled={!settings.shakeEnabled}
            ends={[t("settings.general.shake.firm"), t("settings.general.shake.light")]}
            onCommit={(shakeSensitivity) => change("shake", { shakeSensitivity })}
          />
        </Row>
      </Section>

      <Section title={t("settings.general.startup.title")} error={errors.startup}>
        <Row label={t("settings.general.startup.label")}>
          <Toggle
            checked={view.launchAtLogin}
            label={t("settings.general.startup.toggle")}
            onChange={(enabled) => void toggleLaunchAtLogin(enabled)}
          />
        </Row>
      </Section>

      <UpdatesSection view={view} error={errors.updates} change={change} />

      {view.finderPermission && (
        <Section title={t("settings.general.permissions.title")}>
          <Row
            label={t("settings.general.permissions.finder")}
            hint={t("settings.general.permissions.finderHint")}
          >
            <span className="status" data-state={view.finderPermission}>
              {t(PERMISSION_TEXT[view.finderPermission])}
            </span>
            {view.finderPermission === "denied" && (
              <button
                type="button"
                className="link-button"
                onClick={() => void openPermissionSettings("automation")}
              >
                {t("settings.common.openSettings")}
              </button>
            )}
          </Row>
        </Section>
      )}
    </>
  );
}

/** Langue de Rutile : celle du système par défaut, ou une autre au choix. Chaque langue est
 * nommée dans la sienne, pour qu'on retrouve la sienne même sans comprendre la langue en cours. */
function LanguageSection({
  view,
  error,
  change,
}: {
  view: SettingsView;
  error?: string;
  change: Change;
}) {
  const choice = view.settings.language;
  return (
    <Section title={t("settings.language.title")} error={error}>
      <Row label={t("settings.language.label")} hint={t("settings.language.hint")}>
        <select
          className="text-input language-select"
          aria-label={t("settings.language.label")}
          value={choice ?? "system"}
          onChange={(event) => {
            const next = event.target.value === "system" ? null : event.target.value;
            change("language", { language: next });
            // Dans un navigateur, Rust n'est pas là pour annoncer la nouvelle langue
            if (!isTauri()) setLanguage(next ?? view.systemLanguage);
          }}
        >
          <option value="system">
            {t("settings.language.system", { name: languageName(view.systemLanguage) })}
          </option>
          {LANGUAGES.map(({ code, name }) => (
            <option key={code} value={code} lang={code}>
              {name}
            </option>
          ))}
        </select>
      </Row>
    </Section>
  );
}

/** Où en est la recherche ou l'installation d'une mise à jour. */
type UpdateState =
  | { step: "idle" }
  | { step: "checking" }
  | { step: "done"; status: UpdateStatus }
  | { step: "installing"; progress: number | null }
  | { step: "failed"; message: string };

/** Version installée, recherche et installation d'une mise à jour, recherche automatique. */
function UpdatesSection({
  view,
  error,
  change,
}: {
  view: SettingsView;
  error?: string;
  change: Change;
}) {
  const [state, setState] = useState<UpdateState>({ step: "idle" });

  // L'avancement arrive pendant le téléchargement ; Rutile redémarre ensuite
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<number>(UPDATE_PROGRESS_EVENT, ({ payload }) =>
      setState({ step: "installing", progress: payload }),
    );
    return () => void unlisten.then((stop) => stop());
  }, []);

  const check = async () => {
    setState({ step: "checking" });
    try {
      const status = isTauri()
        ? await checkUpdate()
        : { current: view.version, available: "9.9.0", notes: null };
      setState({ step: "done", status });
    } catch (err) {
      setState({ step: "failed", message: String(err) });
    }
  };

  const install = async () => {
    setState({ step: "installing", progress: null });
    try {
      if (isTauri()) await installUpdate();
    } catch (err) {
      setState({ step: "failed", message: String(err) });
    }
  };

  const available = state.step === "done" ? state.status.available : null;
  const hint =
    state.step === "checking"
      ? t("settings.updates.searching")
      : state.step === "installing"
        ? state.progress === null
          ? t("settings.updates.downloading")
          : t("settings.updates.progress", { percent: Math.round(state.progress * 100) })
        : state.step === "failed"
          ? state.message
          : state.step === "done"
            ? available
              ? t("settings.updates.available", { version: available })
              : t("settings.updates.upToDate")
            : undefined;

  return (
    <Section title={t("settings.updates.title")} error={error}>
      <Row label={t("settings.updates.version", { version: view.version })} hint={hint}>
        {available ? (
          <button
            type="button"
            className="link-button"
            disabled={state.step !== "done"}
            onClick={() => void install()}
          >
            {t("settings.updates.install", { version: available })}
          </button>
        ) : (
          <button
            type="button"
            className="link-button"
            disabled={state.step === "checking" || state.step === "installing"}
            onClick={() => void check()}
          >
            {t("settings.updates.check")}
          </button>
        )}
      </Row>
      <Row
        label={t("settings.updates.auto")}
        hint={t("settings.updates.autoHint")}
      >
        <Toggle
          checked={view.settings.autoUpdate}
          label={t("settings.updates.autoAria")}
          onChange={(autoUpdate) => change("updates", { autoUpdate })}
        />
      </Row>
    </Section>
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
        {recording ? t("settings.general.shortcut.recording") : label}
      </button>
      {recording && hint && <span className="row-hint">{hint}</span>}
    </div>
  );
}
