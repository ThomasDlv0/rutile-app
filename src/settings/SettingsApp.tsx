import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ActionsIcon } from "../ActionsIcon";
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
  pickAppFolder,
  pickShareFolder,
  setLaunchAtLogin,
  shareChoices,
  updateSettings,
  videoSupport,
  type AppKind,
  type AppSlot,
  type CustomAction,
  type CustomWheel,
  type FileKind,
  type FirstWheel,
  type PartEntry,
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
import { ActionGlyph } from "../wheel/ActionGlyph";
import {
  type ActionNode,
  type Arranged,
  DEFAULT_FILE_WHEELS,
  FILE_ACTIONS,
  FILE_KIND_LABELS,
  actionCatalog,
  actionTree,
  arrange,
  partEntries,
} from "../wheel/actions";
import { readableInk } from "../wheel/color";
import { DEFAULT_ACCENT } from "../wheel/color";
import {
  type Mode,
  OUTPUT_FORMATS,
  VIDEO_FORMATS,
  type WheelItem,
  colorize,
  shareIcon,
} from "../wheel/formats";
import { CENTER, MAX_SECTORS, SECTOR_COUNT, isInsideHub } from "../wheel/geometry";
import { type Point, usableSector } from "../wheel/selection";
import { Wheel } from "../wheel/Wheel";
import { recordShortcut } from "./accelerator";
import { moved, type SortableRow, useSortable } from "./useSortable";
import "./settings.css";

type SectionId =
  | "wheels"
  | "colors"
  | "actions"
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
  { id: "actions", label: "Actions" },
  { id: "apps", label: "Apps" },
  { id: "share", label: "Partage" },
];

const MODE_LABELS: Record<Mode, string> = {
  image: "Convertisseur d'images",
  video: "Convertisseur de vidéos",
  apps: "Applications",
  share: "Partage",
  actions: "Actions",
};

function ModeIcon({ mode }: { mode: Mode }) {
  if (mode === "video") return <FilmIcon size={22} />;
  if (mode === "apps") return <AppsIcon size={22} />;
  if (mode === "share") return <ShareIcon size={22} />;
  if (mode === "actions") return <ActionsIcon size={22} />;
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
      { id: "actions", enabled: true },
    ],
    rememberWheel: false,
    dwellMs: 1000,
    formatColors: {},
    highlightColor: null,
    wheelBorder: "light",
    wheelGlass: true,
    captureReopen: true,
    customWheels: [],
    actionParts: [],
    fileWheels: DEFAULT_FILE_WHEELS,
    apps: [
      { path: "/Applications/Finder.app", name: "Finder", kind: "app" },
      null,
      null,
      null,
      null,
      null,
    ],
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
  nativeGlass: true,
  platform: "macos",
  version: "1.3.1",
  apps: [
    { path: "/Applications/Finder.app", name: "Finder", kind: "app", icon: null },
    null,
    null,
    null,
    null,
    null,
  ],
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
        {tab === "colors" && (
          <ColorsTab
            settings={settings}
            nativeGlass={view.nativeGlass}
            error={errors.colors}
            change={change}
          />
        )}
        {tab === "actions" && <ActionsTab view={view} errors={errors} change={change} />}
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
          label="Temps de maintien"
          hint="Au centre pendant un glisser pour basculer entre conversion et partage, ou sur une part de la roue Actions pour ouvrir ses options."
        >
          <Slider
            label="Temps de maintien"
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
          Un fichier ouvre d'abord la roue réglée pour son type dans l'onglet Actions : le
          convertisseur pour une image ou une vidéo, la roue Actions pour le reste. En glissant
          un fichier, restez au centre pour passer à la roue de partage.
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

type PreviewMode = "image" | "video" | "actions";

/** Roues dont on règle les couleurs, avec les couleurs par défaut de leurs parts. */
const COLOR_GROUPS: { mode: PreviewMode; title: string; parts: readonly WheelItem[] }[] = [
  { mode: "image", title: "Images", parts: OUTPUT_FORMATS },
  { mode: "video", title: "Vidéos", parts: VIDEO_FORMATS },
  // Parts dans l'ordre réglé, calculées par l'onglet
  { mode: "actions", title: "Actions", parts: [] },
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
  nativeGlass,
  error,
  change,
}: {
  settings: Settings;
  nativeGlass: boolean;
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
  const [previewMode, setPreviewMode] = useState<PreviewMode>("image");
  const actionParts = useMemo(
    () => actionTree({ custom: [], windowLayout: true, actionParts: settings.actionParts }),
    [settings.actionParts],
  );
  const known = COLOR_GROUPS.find(({ mode }) => mode === previewMode) ?? COLOR_GROUPS[0];
  const group = known.mode === "actions" ? { ...known, parts: actionParts } : known;

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

  const setPartColor = (part: WheelItem, color: string) => {
    const colors = { ...draft.colors };
    // Revenir à la couleur d'origine retire le choix, plutôt que de l'enregistrer
    if (color === part.color) delete colors[part.id];
    else colors[part.id] = color;
    update({ ...draft, colors });
  };

  // Le sélecteur du système s'ouvre sur la part cliquée, ou le centre pour la surbrillance
  const picker = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<WheelItem | "highlight" | null>(null);
  const editedColor = (target: WheelItem | "highlight") =>
    target === "highlight"
      ? (draft.highlight ?? DEFAULT_ACCENT)
      : (draft.colors[target.id] ?? target.color ?? DEFAULT_ACCENT);
  const edit = (target: WheelItem | "highlight") => {
    setEditing(target);
    if (!picker.current) return;
    picker.current.value = editedColor(target);
    picker.current.click();
  };
  const setHighlight = (color: string) =>
    update({ ...draft, highlight: color === DEFAULT_ACCENT ? null : color });

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
            parts={group.parts}
            colors={draft.colors}
            highlight={draft.highlight}
            border={draft.border}
            glass={settings.wheelGlass}
            onPart={edit}
            onHub={() => edit("highlight")}
          />
          <input
            ref={picker}
            className="color-picker-input"
            type="color"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const color = event.target.value.toLowerCase();
              if (editing === "highlight") setHighlight(color);
              else if (editing) setPartColor(editing, color);
            }}
          />
          <p className="row-hint">
            Cliquez sur une part pour changer sa couleur, sur le centre pour la surbrillance.
          </p>
        </div>
      </Section>

      <Section title="Matière">
        <Row
          label="Liquid Glass"
          hint={
            nativeGlass
              ? "Le verre de macOS : il réfracte et reflète ce qu'il y a derrière la roue."
              : "Une imitation : le vrai verre n'existe que sur macOS 26 ou plus récent."
          }
        >
          <Toggle
            checked={settings.wheelGlass}
            label="Liquid Glass"
            onChange={(wheelGlass) => change("colors", { wheelGlass })}
          />
        </Row>
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

      <Section title="Surbrillance" error={error}>
        <Row label="Part survolée" hint="Secteur éclairé et anneau autour du bouton visé.">
          <ColorField
            label="Part survolée"
            value={draft.highlight ?? DEFAULT_ACCENT}
            hideLabel
            onChange={setHighlight}
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

/** Roue réduite, aux couleurs en cours de réglage. Le survol y fonctionne comme sur la vraie,
 * et un clic choisit la couleur de ce qu'il touche. */
function WheelPreview({
  mode,
  parts,
  colors,
  highlight,
  border,
  glass,
  onPart,
  onHub,
}: {
  mode: PreviewMode;
  parts: readonly WheelItem[];
  colors: Record<string, string>;
  highlight: string | null;
  border: WheelBorder;
  glass: boolean;
  onPart: (part: WheelItem) => void;
  onHub: () => void;
}) {
  const [pointer, setPointer] = useState<Point | null>(null);
  const items = colorize(parts, colors);
  const highlighted = pointer && usableSector(...pointer, new Set(), items);
  const hovered = highlighted === null ? null : items[highlighted];
  const overHub = pointer !== null && isInsideHub(...pointer);
  return (
    <div
      className="wheel-preview"
      style={{ width: CENTER * 2 * PREVIEW_SCALE, height: CENTER * 2 * PREVIEW_SCALE }}
    >
      <div style={{ transform: `scale(${PREVIEW_SCALE})`, transformOrigin: "top left" }}>
        <Wheel
          phase="open"
          mode={mode}
          next={mode}
          items={items}
          disabled={new Set()}
          highlighted={highlighted}
          hub={
            hovered
              ? { label: `Couleur : ${hovered.label}`, tone: "action" }
              : overHub
                ? { label: "Couleur de surbrillance", tone: "action" }
                : null
          }
          work={null}
          dwelling={false}
          dwellMs={1000}
          accent={highlight}
          border={border}
          glass={glass ? "css" : "off"}
          scale={PREVIEW_SCALE}
          onPointer={setPointer}
          onSelect={(index) => onPart(parts[index])}
          onOutsideClick={() => {}}
          onToggleMode={onHub}
        />
      </div>
    </div>
  );
}

const CUSTOM_KINDS: { id: CustomAction["kind"]; label: string; placeholder: string }[] = [
  { id: "shortcut", label: "Raccourci", placeholder: "Nom dans l'app Raccourcis" },
  { id: "command", label: "Commande", placeholder: "Commande (fichiers : $1, $2…)" },
  { id: "url", label: "Site web", placeholder: "https://…" },
];

/** Ajout d'une action à une roue personnalisée. */
function CustomActionForm({
  platform,
  onAdd,
}: {
  platform: string;
  onAdd: (action: CustomAction) => void;
}) {
  const kinds = CUSTOM_KINDS.filter(({ id }) => id !== "shortcut" || platform === "macos");
  const [kind, setKind] = useState(kinds[0].id);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const url = kind === "url" ? webAddress(value) : null;
  const ready = name.trim() !== "" && value.trim() !== "" && (kind !== "url" || url !== null);
  return (
    <form
      className="custom-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onAdd({ name: name.trim(), kind, value: url ?? value.trim() });
        setName("");
        setValue("");
      }}
    >
      <input
        className="text-input"
        aria-label="Nom de l'action"
        placeholder="Nom de l'action"
        maxLength={40}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <select
        className="text-input"
        aria-label="Type d'action"
        value={kind}
        onChange={(event) => setKind(event.target.value as CustomAction["kind"])}
      >
        {kinds.map(({ id, label }) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      <input
        className="text-input custom-form-value"
        aria-label="Ce que lance l'action"
        placeholder={CUSTOM_KINDS.find(({ id }) => id === kind)?.placeholder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="shortcut-button" disabled={!ready}>
        Ajouter
      </button>
    </form>
  );
}

/** Pastille d'une part de la roue Actions, à sa couleur. */
function PartChip({ node, colors }: { node: ActionNode; colors: Record<string, string> }) {
  const color =
    colors[node.id] ?? (node.family !== undefined ? colors[node.family] : undefined) ?? node.color;
  return (
    <span
      className="part-chip"
      style={color ? { background: color, color: readableInk(color) } : undefined}
    >
      <ActionGlyph name={node.glyph} size={15} />
    </span>
  );
}

/** Lignes d'une liste de parts qu'on réordonne en glissant et qu'on affiche ou masque. Au
 * moins une part reste affichée. */
function usePartRows(
  parts: readonly Arranged<ActionNode>[],
  colors: Record<string, string>,
  onChange: (entries: PartEntry[]) => void,
) {
  const sortable = useSortable(parts.length, (from, to) =>
    onChange(partEntries(moved(parts, from, to))),
  );
  const shown = parts.filter(({ enabled }) => enabled).length;
  const rows = parts.map(({ item, enabled }, index) => (
    <Row
      key={item.id}
      label={item.label}
      hint={item.setup ? "Vos roues personnalisées, s'il y en a" : item.action}
      icon={<PartChip node={item} colors={colors} />}
      muted={!enabled}
      sortable={sortable.row(index)}
      handle={<DragHandle label={item.label} {...sortable.handle(index)} />}
    >
      <Toggle
        checked={enabled}
        label={`Afficher ${item.label}`}
        disabled={enabled && shown === 1}
        onChange={(next) =>
          onChange(
            partEntries(parts.map((part, i) => (i === index ? { ...part, enabled: next } : part))),
          )
        }
      />
    </Row>
  ));
  return { rows, sorting: sortable.sorting };
}

const FILE_KINDS = Object.keys(FILE_KIND_LABELS) as FileKind[];

/** Ce que propose le menu « S'ouvre sur », selon le type de fichier. */
function firstChoices(kind: FileKind): { id: FirstWheel; label: string; mode: Mode | null }[] {
  const convert =
    kind === "images"
      ? [{ id: "convert" as const, label: "Convertisseur d'images", mode: "image" as const }]
      : kind === "videos"
        ? [{ id: "convert" as const, label: "Convertisseur vidéo", mode: "video" as const }]
        : [];
  return [
    ...convert,
    { id: "actions", label: "Roue Actions", mode: "actions" },
    { id: "share", label: "Partage", mode: "share" },
    { id: "apps", label: "Apps", mode: "apps" },
    { id: "usual", label: "Première roue de la liste", mode: null },
  ];
}

/** D'où viennent les fichiers sélectionnés, selon le système. */
const fileManager = (platform: string) =>
  platform === "macos" ? "le Finder" : platform === "windows" ? "l'Explorateur" : "vos fichiers";

function ActionsTab({ view, errors, change }: { view: SettingsView; errors: Errors; change: Change }) {
  const { settings } = view;
  const colors = settings.formatColors;
  const wheels = settings.customWheels;
  const setWheels = (customWheels: CustomWheel[]) => change("actions", { customWheels });
  const replace = (index: number, wheel: CustomWheel) =>
    setWheels(wheels.map((known, i) => (i === index ? wheel : known)));

  const windowLayout = view.platform !== "linux" || !view.wayland;
  const rootParts = arrange(actionCatalog({ custom: [], windowLayout }), settings.actionParts);
  const root = usePartRows(rootParts, colors, (actionParts) => change("actions", { actionParts }));

  const [kind, setKind] = useState<FileKind>("images");
  const fileWheel = settings.fileWheels[kind];
  const setFileWheel = (next: Partial<typeof fileWheel>) =>
    change("actions", {
      fileWheels: { ...settings.fileWheels, [kind]: { ...fileWheel, ...next } },
    });
  const fileParts = arrange(FILE_ACTIONS[kind], fileWheel.parts);
  const forFiles = usePartRows(fileParts, colors, (parts) => setFileWheel({ parts }));
  const choices = firstChoices(kind);
  const chosen = choices.find(({ id }) => id === fileWheel.first) ?? choices[choices.length - 1];
  const chosenOff =
    chosen.mode !== null &&
    !settings.modes.some((entry) => entry.id === chosen.mode && entry.enabled);

  return (
    <>
      <Section title="Roue Actions" error={errors.wheels} sorting={root.sorting}>
        <WheelSwitch settings={settings} mode="actions" label="Afficher la roue Actions" change={change} />
        {root.rows}
        <p className="section-note">
          Glissez une part par sa poignée pour la déplacer : la première est en haut de la roue,
          les suivantes dans le sens des aiguilles d'une montre. Restez une seconde sur une part
          pour ouvrir ses options ; le centre ramène à la roue d'avant, comme Échap.
        </p>
      </Section>

      <Section title="Selon le fichier" error={errors.actions} sorting={forFiles.sorting}>
        <div className="kind-switch">
          <div className="segmented segmented-fill" role="tablist" aria-label="Type de fichier">
            {FILE_KINDS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={kind === id}
                onClick={() => setKind(id)}
              >
                {FILE_KIND_LABELS[id]}
              </button>
            ))}
          </div>
        </div>
        <Row
          label="S'ouvre sur"
          hint={
            chosenOff
              ? "Cette roue est désactivée : la première de la liste s'ouvre à sa place."
              : "La roue affichée quand arrive un fichier de ce type."
          }
        >
          <select
            className="text-input"
            aria-label="Roue ouverte d'abord"
            value={chosen.id}
            onChange={(event) => setFileWheel({ first: event.target.value as FirstWheel })}
          >
            {choices.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Row>
        {/* Remontées à chaque type : un interrupteur ne glisse pas d'un type à l'autre */}
        <Fragment key={kind}>{forFiles.rows}</Fragment>
        <p className="section-note">
          Un fichier secoué, glissé sur la roue ou sélectionné dans {fileManager(view.platform)}{" "}
          ouvre la roue choisie. Sa roue Actions ne montre que ces actions, dans cet ordre, et
          seulement celles qui ont un sens (la fusion à partir de deux PDF) ; dix au plus.
          Plusieurs types mélangés comptent comme « Autres ».
        </p>
      </Section>

      <Section title="Capture">
        <Row
          label="Rouvrir la roue après une capture"
          hint="Pour convertir ou partager l'image tout de suite."
        >
          <Toggle
            checked={settings.captureReopen}
            label="Rouvrir la roue après une capture"
            onChange={(captureReopen) => change("actions", { captureReopen })}
          />
        </Row>
        {view.platform === "macos" && (
          <Row
            label="Capture et lecture du texte"
            hint="macOS demande l'autorisation Enregistrement de l'écran, à redonner après une mise à jour."
          >
            <button
              type="button"
              className="link-button"
              onClick={() => void openPermissionSettings("screen")}
            >
              Ouvrir les réglages
            </button>
          </Row>
        )}
        {view.dockAccess !== null && (
          <DockBadgesRow
            allowed={view.dockAccess}
            label="Ranger les fenêtres"
            hint="Déplacer la fenêtre d'une autre app demande l'autorisation Accessibilité."
          />
        )}
      </Section>

      <Section title="Mes roues" sorting={false}>
        {wheels.map((wheel, index) => (
          <CustomWheelEditor
            key={index}
            wheel={wheel}
            platform={view.platform}
            onChange={(next) => replace(index, next)}
            onRemove={() => setWheels(wheels.filter((_, i) => i !== index))}
          />
        ))}
        {wheels.length < MAX_SECTORS && (
          <AddRow
            label="Créer une roue"
            onClick={() =>
              setWheels([
                ...wheels,
                { name: `Roue ${wheels.length + 1}`, actions: [], extensions: [] },
              ])
            }
          />
        )}
        <p className="section-note">
          Vos roues s'ouvrent depuis la part « Mes roues » de la roue Actions. Une commande reçoit
          les fichiers de la roue en arguments. Avec des extensions, une roue n'apparaît que pour
          ces fichiers.
        </p>
      </Section>
    </>
  );
}

/** `.PDF, docx; txt` → `["pdf", "docx", "txt"]`. */
function parseExtensions(text: string): string[] {
  const extensions = text
    .split(/[\s,;]+/)
    .map((extension) => extension.replace(/^\.+/, "").toLowerCase())
    .filter((extension) => /^[\p{L}\p{N}]{1,10}$/u.test(extension));
  return [...new Set(extensions)];
}

/** Une roue personnalisée : son nom, les fichiers qu'elle concerne, ses actions dans l'ordre. */
function CustomWheelEditor({
  wheel,
  platform,
  onChange,
  onRemove,
}: {
  wheel: CustomWheel;
  platform: string;
  onChange: (wheel: CustomWheel) => void;
  onRemove: () => void;
}) {
  const sortable = useSortable(wheel.actions.length, (from, to) =>
    onChange({ ...wheel, actions: moved(wheel.actions, from, to) }),
  );
  return (
    <div className="custom-wheel" data-sorting={sortable.sorting || undefined}>
      <div className="custom-wheel-head">
        <input
          className="text-input"
          aria-label="Nom de la roue"
          maxLength={30}
          defaultValue={wheel.name}
          onBlur={(event) => {
            const name = event.target.value.trim();
            if (name && name !== wheel.name) onChange({ ...wheel, name });
          }}
        />
        <button type="button" className="link-button" onClick={onRemove}>
          Supprimer
        </button>
      </div>
      <div className="custom-wheel-extensions">
        <input
          className="text-input"
          aria-label="Extensions des fichiers concernés"
          placeholder="Pour tous les fichiers, ou : pdf, docx…"
          defaultValue={wheel.extensions.join(", ")}
          onBlur={(event) => {
            const extensions = parseExtensions(event.target.value);
            event.target.value = extensions.join(", ");
            if (extensions.join() !== wheel.extensions.join()) onChange({ ...wheel, extensions });
          }}
        />
      </div>
      {wheel.actions.map((action, slot) => (
        <Row
          key={`${slot}-${action.name}`}
          label={action.name}
          hint={`${CUSTOM_KINDS.find(({ id }) => id === action.kind)?.label} : ${action.value}`}
          sortable={sortable.row(slot)}
          handle={<DragHandle label={action.name} {...sortable.handle(slot)} />}
        >
          <button
            type="button"
            className="link-button"
            onClick={() =>
              onChange({ ...wheel, actions: wheel.actions.filter((_, i) => i !== slot) })
            }
          >
            Retirer
          </button>
        </Row>
      ))}
      {wheel.actions.length < MAX_SECTORS && (
        <CustomActionForm
          platform={platform}
          onAdd={(action) => onChange({ ...wheel, actions: [...wheel.actions, action] })}
        />
      )}
    </div>
  );
}

/** Adresse web complète, `https://` ajouté au besoin ; `null` si ce n'en est pas une. */
function webAddress(text: string): string | null {
  const value = text.trim();
  const address = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(address);
    return url.hostname.includes(".") ? url.href : null;
  } catch {
    return null;
  }
}

/** Nom court d'un site, tiré de son adresse. */
function siteName(address: string): string {
  return new URL(address).hostname.replace(/^www\./, "");
}

/** Ce que devient une part qui n'ouvre pas une app. */
const SLOT_KINDS: Record<Exclude<AppKind, "app">, string> = {
  folder: "Dossier",
  url: "Site web",
};

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

  // Dans la première part libre, ou une part de plus
  const place = (picked: AppSlot) => {
    const free = settings.apps.indexOf(null);
    const apps = [...settings.apps];
    apps[free >= 0 ? free : count] = picked;
    setApps(apps);
  };
  const chooseFolder = async () => {
    const picked = isTauri() ? await pickAppFolder() : null;
    if (picked) place(picked);
  };
  const [site, setSite] = useState<string | null>(null);
  const siteAddress = site === null ? null : webAddress(site);

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
              hint={app && app.kind !== "app" ? `${SLOT_KINDS[app.kind]} · ${position}` : position}
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
          <>
            <AddRow label="Ajouter une app" onClick={() => void chooseApp(count)} />
            <AddRow label="Ajouter un dossier" onClick={() => void chooseFolder()} />
            {site === null ? (
              <AddRow label="Ajouter un site web" onClick={() => setSite("")} />
            ) : (
              <form
                className="custom-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!siteAddress) return;
                  place({ path: siteAddress, name: siteName(siteAddress), kind: "url" });
                  setSite(null);
                }}
              >
                <input
                  className="text-input custom-form-value"
                  aria-label="Adresse du site"
                  placeholder="exemple.fr"
                  autoFocus
                  value={site}
                  onChange={(event) => setSite(event.target.value)}
                />
                <button type="submit" className="shortcut-button" disabled={!siteAddress}>
                  Ajouter
                </button>
              </form>
            )}
          </>
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
function DockBadgesRow({
  allowed: initial,
  label = "Pastilles des apps fermées",
  hint = "Messages ou Mail gardent la leur dans le Dock une fois fermés ; Rutile l'y lit avec l'autorisation Accessibilité.",
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
