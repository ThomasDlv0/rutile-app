import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AppsIcon } from "../AppsIcon";
import { FilmIcon } from "../FilmIcon";
import { GemIcon } from "../GemIcon";
import { ShareIcon } from "../ShareIcon";
import {
  SETTINGS_TAB_EVENT,
  UPDATE_PROGRESS_EVENT,
  allowDockBadges,
  checkUpdate,
  dockBadgesAllowed,
  getSettings,
  installUpdate,
  openPermissionSettings,
  pickApp,
  pickShareFolder,
  setLaunchAtLogin,
  shareChoices,
  updateSettings,
  videoSupport,
  type Settings,
  type SettingsTab,
  type SettingsView,
  type ShareChoice,
  type ShareTarget,
  type ShareView,
  type UpdateStatus,
  type VideoSupport,
  type WheelBorder,
} from "../ipc";
import { DEFAULT_ACCENT } from "../wheel/color";
import {
  type Mode,
  OUTPUT_FORMATS,
  VIDEO_FORMATS,
  type WheelItem,
  colorize,
  shareIcon,
} from "../wheel/formats";
import { CENTER, MAX_SECTORS, SECTOR_COUNT } from "../wheel/geometry";
import { type Point, usableSector } from "../wheel/selection";
import { Wheel } from "../wheel/Wheel";
import { recordShortcut } from "./accelerator";
import { moved, type SortableRow, useSortable } from "./useSortable";
import "./settings.css";

type SectionId =
  | "wheels"
  | "colors"
  | "apps"
  | "share"
  | "shortcut"
  | "shake"
  | "quality"
  | "startup"
  | "updates";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "Général" },
  { id: "wheels", label: "Roues" },
  { id: "conversion", label: "Conversion" },
  { id: "colors", label: "Couleurs" },
  { id: "apps", label: "Apps" },
  { id: "share", label: "Partage" },
];

const MODE_LABELS: Record<Mode, string> = {
  image: "Convertisseur d'images",
  video: "Convertisseur de vidéos",
  apps: "Applications",
  share: "Partage",
};

function ModeIcon({ mode }: { mode: Mode }) {
  if (mode === "video") return <FilmIcon size={22} />;
  if (mode === "apps") return <AppsIcon size={22} />;
  if (mode === "share") return <ShareIcon size={22} />;
  return <GemIcon size={22} />;
}

const DIRECTIONS = [
  "En haut",
  "En haut à droite",
  "À droite",
  "En bas à droite",
  "En bas",
  "En bas à gauche",
  "À gauche",
  "En haut à gauche",
];

/** Où se trouve la part `index` d'une roue de `count` parts, dans le sens horaire depuis le
 * haut. */
function slotPosition(index: number, count: number): string {
  return DIRECTIONS[Math.round((index * 8) / count) % 8];
}

/** Ce que fait une destination, sous son nom. */
const SHARE_KINDS: Record<ShareTarget["kind"], string> = {
  service: "Partage du système",
  folder: "Copie dans le dossier",
  app: "Copie et ouvre l'app",
  system: "Menu de partage du système",
};

// Aperçu dans un navigateur, sans Tauri
const PREVIEW_SHARE: (ShareView | null)[] = [
  { kind: "service", id: "com.apple.share.AirDrop.send", name: "AirDrop", icon: null },
  { kind: "service", id: "com.apple.share.Messages.window", name: "Messages", icon: null },
  { kind: "app", path: "/Applications/Signal.app", name: "Signal", icon: null },
  { kind: "folder", path: "/iCloud", name: "iCloud Drive", icon: null },
  { kind: "service", id: "com.apple.share.Mail.compose", name: "Mail", icon: null },
  null,
];

const PREVIEW_CHOICES: ShareChoice[] = [
  ...PREVIEW_SHARE.filter((view) => view !== null).map((view) => ({
    ...view,
    group:
      view.kind === "service"
        ? "Partage du système"
        : view.kind === "folder"
          ? "Dossiers synchronisés"
          : "Messageries",
  })),
  { kind: "system", name: "Partager…", icon: null, group: "Partage du système" },
  { kind: "service", id: "notes", name: "Notes", icon: null, group: "Partage du système" },
];

const PREVIEW: SettingsView = {
  settings: {
    shortcut: "CommandOrControl+Shift+Space",
    shakeEnabled: true,
    shakeSensitivity: 5,
    jpegQuality: 90,
    webpQuality: 85,
    avifQuality: 70,
    modes: [
      { id: "image", enabled: true },
      { id: "video", enabled: true },
      { id: "apps", enabled: true },
      { id: "share", enabled: true },
    ],
    rememberWheel: false,
    dwellMs: 1000,
    formatColors: {},
    highlightColor: null,
    wheelBorder: "light",
    apps: [{ path: "/Applications/Finder.app", name: "Finder" }, null, null, null, null, null],
    share: PREVIEW_SHARE.map((view) => view && targetOf(view)),
    autoUpdate: true,
  },
  shortcutLabel: "⌘⇧Espace",
  defaultShortcut: "CommandOrControl+Shift+Space",
  shortcutsSupported: true,
  wayland: false,
  launchAtLogin: false,
  finderPermission: "granted",
  dockAccess: false,
  platform: "macos",
  version: "1.1.0",
  apps: [{ path: "/Applications/Finder.app", name: "Finder", icon: null }, null, null, null, null, null],
  share: PREVIEW_SHARE,
  tab: null,
};

const PERMISSION_TEXT: Record<NonNullable<SettingsView["finderPermission"]>, string> = {
  granted: "Autorisée",
  denied: "Refusée",
  notAsked: "Demandée à la première utilisation",
  unknown: "Inconnue",
};

/** Les curseurs n'enregistrent qu'une fois relâchés depuis un court instant. */
const SLIDER_COMMIT_MS = 300;

/** Destination à enregistrer, sans ce qui ne sert qu'à l'affichage. */
function targetOf(view: ShareView): ShareTarget {
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

export function SettingsApp() {
  const [view, setView] = useState<SettingsView | null>(isTauri() ? null : PREVIEW);
  const [tab, setTab] = useState<SettingsTab>("general");
  const [errors, setErrors] = useState<Partial<Record<SectionId, string>>>({});

  useEffect(() => {
    if (!isTauri()) return;
    void getSettings().then((loaded) => {
      setView(loaded);
      if (loaded.tab) setTab(loaded.tab);
    });
    // Une part vide de la roue ramène la fenêtre déjà ouverte sur le bon onglet
    const unlisten = listen<SettingsTab>(SETTINGS_TAB_EVENT, ({ payload }) => setTab(payload));
    return () => void unlisten.then((stop) => stop());
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

  return (
    <main className="settings-page">
      <header className="settings-header">
        <GemIcon size={40} />
        <div>
          <h1>Rutile</h1>
          <p>Images, vidéos, apps et partage sur une roue radiale · version {view.version}</p>
        </div>
      </header>

      <nav className="settings-tabs" role="tablist" aria-label="Réglages">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="settings-tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            <TabIcon tab={id} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div role="tabpanel" aria-label={TABS.find(({ id }) => id === tab)?.label}>
        {tab === "general" && (
          <GeneralTab view={view} errors={errors} setErrors={setErrors} setView={setView} change={change} />
        )}
        {tab === "wheels" && <WheelsTab settings={settings} error={errors.wheels} change={change} />}
        {tab === "conversion" && (
          <ConversionTab settings={settings} error={errors.quality} change={change} />
        )}
        {tab === "apps" && <AppsTab view={view} errors={errors} change={change} />}
        {tab === "colors" && <ColorsTab settings={settings} error={errors.colors} change={change} />}
        {tab === "share" && <ShareTab view={view} errors={errors} change={change} />}
      </div>
    </main>
  );
}

type Change = (section: SectionId, patch: Partial<Settings>) => void;
type Errors = Partial<Record<SectionId, string>>;

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
    apps: (
      <>
        <rect x="3.2" y="3.2" width="5.6" height="5.6" rx="1.6" />
        <rect x="11.2" y="3.2" width="5.6" height="5.6" rx="1.6" />
        <rect x="3.2" y="11.2" width="5.6" height="5.6" rx="1.6" />
        <rect x="11.2" y="11.2" width="5.6" height="5.6" rx="1.6" />
      </>
    ),
    share: <path d="M7 8.5H5.5a1 1 0 0 0-1 1V16a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9.5a1 1 0 0 0-1-1H13M10 2.8V12M6.8 6 10 2.8 13.2 6" />,
  };
  return (
    <svg className="tab-icon" width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
      {paths[tab]}
    </svg>
  );
}

function GeneralTab({
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
      <Section title="Ouvrir la roue" error={errors.shortcut}>
        {view.shortcutsSupported ? (
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
        ) : (
          <p className="section-note">
            Sous Wayland, les apps ne peuvent pas écouter le clavier. Liez la commande{" "}
            <code>rutile --open</code> à un raccourci du système : Paramètres → Clavier →
            Raccourcis personnalisés.
          </p>
        )}
        <p className="section-note">
          Dans la roue, ← et → choisissent une part, Entrée la lance ; les chiffres 1 à 9 (0 pour
          la dixième) la lancent directement. ↑ et ↓ changent de roue, Échap la ferme.
        </p>
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

      <Section title="Démarrage" error={errors.startup}>
        <Row label="Lancer Rutile à l'ouverture de session">
          <Toggle
            checked={view.launchAtLogin}
            label="Lancement au démarrage"
            onChange={(enabled) => void toggleLaunchAtLogin(enabled)}
          />
        </Row>
      </Section>

      <UpdatesSection view={view} error={errors.updates} change={change} />

      {view.finderPermission && (
        <Section title="Autorisations">
          <Row
            label="Lire la sélection du Finder"
            hint="Pour convertir ou partager le fichier sélectionné quand la roue s'ouvre."
          >
            <span className="status" data-state={view.finderPermission}>
              {PERMISSION_TEXT[view.finderPermission]}
            </span>
            {view.finderPermission === "denied" && (
              <button
                type="button"
                className="link-button"
                onClick={() => void openPermissionSettings("automation")}
              >
                Ouvrir les réglages
              </button>
            )}
          </Row>
        </Section>
      )}
    </>
  );
}

function WheelsTab({
  settings,
  error,
  change,
}: {
  settings: Settings;
  error?: string;
  change: Change;
}) {
  const enabledCount = settings.modes.filter((entry) => entry.enabled).length;
  const sortable = useSortable(settings.modes.length, (from, to) =>
    change("wheels", { modes: moved(settings.modes, from, to) }),
  );

  return (
    <>
      <Section title="Roues" error={error} sorting={sortable.sorting}>
        {settings.modes.map((entry, index) => (
          <Row
            key={entry.id}
            label={MODE_LABELS[entry.id]}
            icon={<ModeIcon mode={entry.id} />}
            sortable={sortable.row(index)}
            handle={<DragHandle label={MODE_LABELS[entry.id]} {...sortable.handle(index)} />}
          >
            <Toggle
              checked={entry.enabled}
              label={MODE_LABELS[entry.id]}
              // La dernière roue active ne peut pas être désactivée
              disabled={entry.enabled && enabledCount === 1}
              onChange={(enabled) =>
                change("wheels", { modes: withMode(settings, entry.id, enabled) })
              }
            />
          </Row>
        ))}
        <p className="section-note">
          Un clic au centre (ou ↓ au clavier) passe à la roue suivante, dans cet ordre. Glissez
          une ligne par sa poignée pour la déplacer.
        </p>
      </Section>

      <Section title="Comportement">
        <Row
          label="Temps au centre avant de basculer"
          hint="Pendant un glisser, entre conversion et partage."
        >
          <Slider
            label="Temps au centre avant de basculer"
            value={settings.dwellMs}
            min={400}
            max={2500}
            step={100}
            showValue
            formatValue={(ms) => `${(ms / 1000).toLocaleString("fr-FR", { minimumFractionDigits: 1 })} s`}
            onCommit={(dwellMs) => change("wheels", { dwellMs })}
          />
        </Row>
        <Row
          label="Rouvrir sur la dernière roue utilisée"
          hint={
            settings.rememberWheel
              ? "La roue revient là où vous étiez."
              : "Sinon, la roue s'ouvre sur la première de la liste."
          }
        >
          <Toggle
            checked={settings.rememberWheel}
            label="Rouvrir sur la dernière roue"
            onChange={(rememberWheel) => change("wheels", { rememberWheel })}
          />
        </Row>
        <p className="section-note">
          Une image ouvre directement le convertisseur d'images, une vidéo celui de vidéos. En
          glissant un fichier, restez au centre pour passer à la roue de partage, puis revenez-y
          pour repasser au convertisseur.
        </p>
      </Section>
    </>
  );
}

function withMode(settings: Settings, mode: Mode, enabled: boolean): Settings["modes"] {
  return settings.modes.map((entry) => (entry.id === mode ? { ...entry, enabled } : entry));
}

/** Interrupteur d'une roue, en tête de son onglet. */
function WheelSwitch({
  settings,
  mode,
  label,
  change,
}: {
  settings: Settings;
  mode: Mode;
  label: string;
  change: Change;
}) {
  const enabled = settings.modes.some((entry) => entry.id === mode && entry.enabled);
  const onlyOne = settings.modes.filter((entry) => entry.enabled).length === 1;
  return (
    <Row
      label={label}
      icon={<ModeIcon mode={mode} />}
      hint={enabled ? "Ordre et autres roues dans l'onglet Roues." : "Désactivée : elle n'apparaît pas au clic sur le centre."}
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

function ConversionTab({
  settings,
  error,
  change,
}: {
  settings: Settings;
  error?: string;
  change: Change;
}) {
  const [video, setVideo] = useState<VideoSupport | null>(
    isTauri() ? null : { available: true, installHint: "brew install ffmpeg" },
  );
  useEffect(() => {
    if (isTauri()) void videoSupport().then(setVideo);
  }, []);

  return (
    <>
      <Section title="Qualité des formats avec perte" error={error}>
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

      <Section title="Vectorisation">
        <p className="section-note">
          Seule la sortie SVG est vectorisée : l'image est retracée en formes aux couleurs unies,
          nette à toutes les tailles. C'est idéal pour un logo ou une icône, approximatif pour une
          photo. PNG, JPEG, WebP, AVIF et ICO gardent les pixels, et un SVG converti vers eux est
          d'abord rendu en pixels.
        </p>
      </Section>

      <Section title="Vidéos">
        <Row
          label="FFmpeg"
          hint={
            video === null
              ? "Recherche…"
              : video.available
                ? "Convertit les vidéos de la roue Vidéo."
                : `Pour l'installer : ${video.installHint}`
          }
        >
          {video && (
            <span className="status" data-state={video.available ? "granted" : "denied"}>
              {video.available ? "Installé" : "Introuvable"}
            </span>
          )}
        </Row>
      </Section>
    </>
  );
}

/** Formats d'une roue de conversion, avec leur couleur par défaut. */
const COLOR_GROUPS: { mode: "image" | "video"; title: string; formats: readonly WheelItem[] }[] = [
  { mode: "image", title: "Images", formats: OUTPUT_FORMATS },
  { mode: "video", title: "Vidéos", formats: VIDEO_FORMATS },
];

/** Échelle de l'aperçu de la roue dans les réglages. */
const PREVIEW_SCALE = 0.6;

type ColorDraft = {
  colors: Record<string, string>;
  highlight: string | null;
  border: WheelBorder;
};

const BORDERS: { id: WheelBorder; label: string }[] = [
  { id: "light", label: "Clair" },
  { id: "dark", label: "Noir" },
  { id: "none", label: "Aucun" },
];

function ColorsTab({
  settings,
  error,
  change,
}: {
  settings: Settings;
  error?: string;
  change: Change;
}) {
  // Les couleurs s'appliquent à l'aperçu tout de suite, et s'enregistrent un instant après
  const { formatColors, highlightColor, wheelBorder } = settings;
  const [draft, setDraft] = useState<ColorDraft>({
    colors: formatColors,
    highlight: highlightColor,
    border: wheelBorder,
  });
  const timer = useRef<number | undefined>(undefined);
  useEffect(
    () => setDraft({ colors: formatColors, highlight: highlightColor, border: wheelBorder }),
    [formatColors, highlightColor, wheelBorder],
  );
  const [previewMode, setPreviewMode] = useState<"image" | "video">("image");

  const update = (next: ColorDraft) => {
    setDraft(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () =>
        change("colors", {
          formatColors: next.colors,
          highlightColor: next.highlight,
          wheelBorder: next.border,
        }),
      SLIDER_COMMIT_MS,
    );
  };

  const setFormatColor = (format: WheelItem, color: string) => {
    const colors = { ...draft.colors };
    // Revenir à la couleur d'origine retire le choix, plutôt que de l'enregistrer
    if (color === format.color) delete colors[format.id];
    else colors[format.id] = color;
    update({ ...draft, colors });
  };

  const customized =
    Object.keys(draft.colors).length > 0 || draft.highlight !== null || draft.border !== "light";

  return (
    <>
      <Section title="Aperçu">
        <div className="color-preview">
          <div className="segmented" role="tablist" aria-label="Roue de l'aperçu">
            {COLOR_GROUPS.map(({ mode, title }) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={previewMode === mode}
                onClick={() => setPreviewMode(mode)}
              >
                {title}
              </button>
            ))}
          </div>
          <WheelPreview
            mode={previewMode}
            colors={draft.colors}
            highlight={draft.highlight}
            border={draft.border}
          />
          <p className="row-hint">Survolez la roue pour voir la surbrillance.</p>
        </div>
      </Section>

      <Section title="Contour">
        <Row label="Contour de la roue" hint="Le trait qui entoure le disque.">
          <div className="segmented" role="radiogroup" aria-label="Contour de la roue">
            {BORDERS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={draft.border === id}
                onClick={() => update({ ...draft, border: id })}
              >
                {label}
              </button>
            ))}
          </div>
        </Row>
      </Section>

      {COLOR_GROUPS.map(({ mode, title, formats }) => (
        <Section key={mode} title={title}>
          <div className="color-grid">
            {formats.map((format) => (
              <ColorField
                key={format.id}
                label={format.label}
                value={draft.colors[format.id] ?? format.color ?? DEFAULT_ACCENT}
                onChange={(color) => setFormatColor(format, color)}
              />
            ))}
          </div>
        </Section>
      ))}

      <Section title="Surbrillance" error={error}>
        <Row label="Part survolée" hint="Secteur éclairé et anneau autour du bouton visé.">
          <ColorField
            label="Part survolée"
            value={draft.highlight ?? DEFAULT_ACCENT}
            hideLabel
            onChange={(color) =>
              update({ ...draft, highlight: color === DEFAULT_ACCENT ? null : color })
            }
          />
        </Row>
        <Row label="Couleurs d'origine" hint="Le texte des boutons reste lisible : blanc ou foncé selon la couleur.">
          <button
            type="button"
            className="shortcut-button"
            disabled={!customized}
            onClick={() => update({ colors: {}, highlight: null, border: "light" })}
          >
            Réinitialiser
          </button>
        </Row>
      </Section>
    </>
  );
}

/** Pastille de couleur qui ouvre le sélecteur du système, avec son code. */
function ColorField({
  label,
  value,
  hideLabel,
  onChange,
}: {
  label: string;
  value: string;
  hideLabel?: boolean;
  onChange: (color: string) => void;
}) {
  return (
    <label className="color-field">
      <input
        type="color"
        aria-label={`Couleur ${label}`}
        value={value}
        onChange={(event) => onChange(event.target.value.toLowerCase())}
      />
      {!hideLabel && <span className="color-field-label">{label}</span>}
      <span className="color-field-code">{value.toUpperCase()}</span>
    </label>
  );
}

/** Roue réduite, aux couleurs en cours de réglage ; le survol y fonctionne comme sur la vraie. */
function WheelPreview({
  mode,
  colors,
  highlight,
  border,
}: {
  mode: "image" | "video";
  colors: Record<string, string>;
  highlight: string | null;
  border: WheelBorder;
}) {
  const [pointer, setPointer] = useState<Point | null>(null);
  const items = colorize(mode === "image" ? OUTPUT_FORMATS : VIDEO_FORMATS, colors);
  const highlighted = pointer && usableSector(...pointer, new Set(), items);
  const hovered = highlighted === null ? null : items[highlighted];
  return (
    <div
      className="wheel-preview"
      style={{ width: CENTER * 2 * PREVIEW_SCALE, height: CENTER * 2 * PREVIEW_SCALE }}
    >
      <div style={{ transform: `scale(${PREVIEW_SCALE})`, transformOrigin: "top left" }}>
        <Wheel
          phase="open"
          mode={mode}
          next={null}
          items={items}
          disabled={new Set()}
          highlighted={highlighted}
          hub={
            hovered
              ? { label: hovered.action ?? `Convertir en ${hovered.label}`, tone: "action" }
              : null
          }
          work={null}
          dwelling={false}
          dwellMs={1000}
          accent={highlight}
          border={border}
          scale={PREVIEW_SCALE}
          onPointer={setPointer}
          onSelect={() => {}}
          onOutsideClick={() => {}}
          onToggleMode={() => {}}
        />
      </div>
    </div>
  );
}

function AppsTab({ view, errors, change }: { view: SettingsView; errors: Errors; change: Change }) {
  const { settings } = view;
  const count = settings.apps.length;
  const setApps = (apps: Settings["apps"]) => change("apps", { apps });
  const sortable = useSortable(count, (from, to) => setApps(moved(settings.apps, from, to)));

  // `slot` égal au nombre d'emplacements : ajoute une part à la roue
  const chooseApp = async (slot: number) => {
    const picked = isTauri() ? await pickApp() : null;
    if (!picked) return;
    const apps = [...settings.apps];
    apps[slot] = picked;
    setApps(apps);
  };

  // Au-delà de six parts, retirer une app retire sa part ; sinon la part reste, vide
  const remove = (slot: number) =>
    setApps(
      count > SECTOR_COUNT
        ? settings.apps.filter((_, i) => i !== slot)
        : settings.apps.map((app, i) => (i === slot ? null : app)),
    );

  return (
    <>
      <Section title="Roue des apps" error={errors.wheels}>
        <WheelSwitch settings={settings} mode="apps" label="Afficher la roue des apps" change={change} />
      </Section>
      <Section title="Applications" error={errors.apps} sorting={sortable.sorting}>
        {settings.apps.map((_, slot) => {
          const app = view.apps[slot];
          const position = slotPosition(slot, count);
          return (
            <Row
              key={slot}
              label={app ? app.name : "Aucune application"}
              hint={position}
              muted={!app}
              icon={<ItemIcon icon={app?.icon} name={app?.name} />}
              sortable={sortable.row(slot)}
              handle={<DragHandle label={app?.name ?? position} {...sortable.handle(slot)} />}
            >
              <button type="button" className="link-button" onClick={() => void chooseApp(slot)}>
                {app ? "Changer…" : "Choisir…"}
              </button>
              {(app || count > SECTOR_COUNT) && (
                <button type="button" className="link-button" onClick={() => remove(slot)}>
                  Retirer
                </button>
              )}
            </Row>
          );
        })}
        {count < MAX_SECTORS && (
          <AddRow label="Ajouter une app" onClick={() => void chooseApp(count)} />
        )}
        <p className="section-note">
          Un clic sur une part lance l'application ; un fichier déposé dessus s'ouvre avec elle.
          La roue compte de {SECTOR_COUNT} à {MAX_SECTORS} parts.
          {view.platform === "macos" &&
            " Les pastilles de notifications du Dock s'affichent sur les icônes."}
        </p>
      </Section>
      {view.dockAccess !== null && (
        <Section title="Pastilles de notifications">
          <DockBadgesRow allowed={view.dockAccess} />
        </Section>
      )}
    </>
  );
}

/** macOS : les pastilles des apps ouvertes se lisent sans autorisation ; celles que le Dock
 * garde pour les apps fermées demandent l'autorisation Accessibilité. */
function DockBadgesRow({ allowed: initial }: { allowed: boolean }) {
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
    <Row
      label="Pastilles des apps fermées"
      hint="Messages ou Mail gardent la leur dans le Dock une fois fermés ; Rutile l'y lit avec l'autorisation Accessibilité."
    >
      {allowed ? (
        <span className="status" data-state="granted">
          Autorisée
        </span>
      ) : asked ? (
        <button
          type="button"
          className="link-button"
          onClick={() => void openPermissionSettings("accessibility")}
        >
          Ouvrir les réglages
        </button>
      ) : (
        <button type="button" className="link-button" onClick={() => void ask()}>
          Autoriser…
        </button>
      )}
    </Row>
  );
}

function ShareTab({ view, errors, change }: { view: SettingsView; errors: Errors; change: Change }) {
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
      <Section title="Roue de partage" error={errors.wheels}>
        <WheelSwitch
          settings={settings}
          mode="share"
          label="Afficher la roue de partage"
          change={change}
        />
      </Section>
      <Section title="Destinations" error={errors.share} sorting={sortable.sorting}>
        {settings.share.map((_, slot) => {
          const target = view.share[slot];
          const position = slotPosition(slot, count);
          return (
            <Row
              key={slot}
              label={target ? target.name : "Aucune destination"}
              hint={target ? `${position} · ${SHARE_KINDS[target.kind]}` : position}
              muted={!target}
              icon={<ItemIcon icon={target && shareIcon(target)} name={target?.name} />}
              sortable={sortable.row(slot)}
              handle={<DragHandle label={target?.name ?? position} {...sortable.handle(slot)} />}
            >
              <button type="button" className="link-button" onClick={() => setPicking(slot)}>
                {target ? "Changer…" : "Choisir…"}
              </button>
              {(target || count > SECTOR_COUNT) && (
                <button type="button" className="link-button" onClick={() => remove(slot)}>
                  Retirer
                </button>
              )}
            </Row>
          );
        })}
        {count < MAX_SECTORS && (
          <AddRow label="Ajouter une destination" onClick={() => setPicking(count)} />
        )}
        <p className="section-note">
          {view.platform === "macos" &&
            "« Partager… » ouvre le menu de partage de macOS : choisissez l'app, puis le destinataire. AirDrop, Messages et Mail ouvrent directement leur fenêtre d'envoi. "}
          Un dossier synchronisé (Google Drive, iCloud Drive…) reçoit une copie, que son app met
          en ligne. Pour Signal et les messageries sans partage, le fichier est copié puis l'app
          s'ouvre : collez-le avec {paste} dans la conversation.
        </p>
      </Section>
      {picking !== null && (
        <SharePicker
          position={
            picking < count ? slotPosition(picking, count) : "Nouvelle part"
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
        aria-label={`Destination ${position.toLowerCase()}`}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="sheet-title">Destination · {position.toLowerCase()}</h3>
        <div className="sheet-list">
          {choices === null && <p className="sheet-empty">Recherche des destinations…</p>}
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
            <h4>Autre</h4>
            <button type="button" className="sheet-item" onClick={() => void pickFolder()}>
              <span className="sheet-item-glyph" aria-hidden="true">
                ⌂
              </span>
              <span>Un dossier…</span>
            </button>
            <button type="button" className="sheet-item" onClick={() => void pickMessagingApp()}>
              <span className="sheet-item-glyph" aria-hidden="true">
                ✉
              </span>
              <span>Une messagerie…</span>
            </button>
          </div>
        </div>
        <div className="sheet-actions">
          <button type="button" className="shortcut-button" onClick={onCancel}>
            Annuler
          </button>
        </div>
      </div>
    </div>
  );
}

/** Icône d'app ou de destination, ou initiale (« + » pour une part vide). */
function ItemIcon({
  icon,
  name,
  small,
}: {
  icon?: string | null;
  name?: string;
  small?: boolean;
}) {
  if (icon) {
    return <img className="settings-app-icon" data-small={small} src={icon} alt="" />;
  }
  return (
    <span className="settings-app-placeholder" data-small={small} aria-hidden="true">
      {name ? name.slice(0, 1) : "+"}
    </span>
  );
}

function Section({
  title,
  error,
  sorting,
  children,
}: {
  title: string;
  error?: string;
  /** Une ligne est en train d'être glissée : les autres s'écartent en douceur. */
  sorting?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <h2>{title}</h2>
      <div className="settings-card" data-sorting={sorting || undefined}>
        {children}
      </div>
      {error && (
        <p className="section-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function Row({
  label,
  hint,
  icon,
  muted,
  sortable,
  handle,
  children,
}: {
  label: string;
  hint?: string;
  icon?: ReactNode;
  muted?: boolean;
  /** Ligne d'une liste qu'on réordonne en glissant, par sa poignée `handle`. */
  sortable?: SortableRow;
  handle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="settings-row"
      data-muted={muted}
      data-dragging={sortable?.dragging || undefined}
      ref={sortable?.ref}
      style={sortable?.style}
    >
      {handle}
      {icon && <span className="row-icon">{icon}</span>}
      <div className="row-text">
        <span className="row-label">{label}</span>
        {hint && <span className="row-hint">{hint}</span>}
      </div>
      <div className="row-control">{children}</div>
    </div>
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
      ? "Recherche…"
      : state.step === "installing"
        ? state.progress === null
          ? "Téléchargement…"
          : `Téléchargement… ${Math.round(state.progress * 100)} %`
        : state.step === "failed"
          ? state.message
          : state.step === "done"
            ? available
              ? `Rutile ${available} est disponible.`
              : "Rutile est à jour."
            : undefined;

  return (
    <Section title="Mises à jour" error={error}>
      <Row label={`Rutile ${view.version}`} hint={hint}>
        {available ? (
          <button
            type="button"
            className="link-button"
            disabled={state.step !== "done"}
            onClick={() => void install()}
          >
            Installer {available}
          </button>
        ) : (
          <button
            type="button"
            className="link-button"
            disabled={state.step === "checking" || state.step === "installing"}
            onClick={() => void check()}
          >
            Rechercher
          </button>
        )}
      </Row>
      <Row
        label="Rechercher automatiquement"
        hint="Au lancement, puis toutes les six heures ; Rutile demande avant d'installer."
      >
        <Toggle
          checked={view.settings.autoUpdate}
          label="Rechercher automatiquement les mises à jour"
          onChange={(autoUpdate) => change("updates", { autoUpdate })}
        />
      </Row>
    </Section>
  );
}

/** Poignée d'une ligne déplaçable : à glisser, ou flèches haut et bas au clavier. */
function DragHandle({
  label,
  ...handle
}: { label: string } & ReturnType<ReturnType<typeof useSortable>["handle"]>) {
  return (
    <button
      type="button"
      className="drag-handle"
      aria-label={`Déplacer ${label}`}
      title="Glisser pour déplacer"
      {...handle}
    >
      <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
        {[3, 8, 13].flatMap((y) =>
          [2.5, 7.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.4" />),
        )}
      </svg>
    </button>
  );
}

/** Dernière ligne d'une liste : ajoute un élément. */
function AddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="settings-row add-row" onClick={onClick}>
      <span className="add-row-icon" aria-hidden="true">
        +
      </span>
      <span className="row-label">{label}</span>
    </button>
  );
}

function Toggle({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="toggle"
      disabled={disabled}
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
  step,
  disabled,
  showValue,
  formatValue = String,
  ends,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  showValue?: boolean;
  formatValue?: (value: number) => string;
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
        step={step}
        value={draft}
        disabled={disabled}
        style={{ "--fill": `${((draft - min) / (max - min)) * 100}%` } as React.CSSProperties}
        onChange={(event) => update(Number(event.target.value))}
      />
      {ends && <span className="slider-end">{ends[1]}</span>}
      {showValue && <span className="slider-value">{formatValue(draft)}</span>}
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
