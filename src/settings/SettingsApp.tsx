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
import { GemIcon } from "../GemIcon";
import { WheelsIcon } from "../WheelsIcon";
import {
  SETTINGS_REFRESH_EVENT,
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
  type AppKind,
  type CustomPart,
  type CustomWheel,
  type CustomWheelView,
  type FileKind,
  type FileWheels,
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
import {
  type ActionNode,
  type Arranged,
  DEFAULT_FILE_WHEELS,
  FILE_ACTIONS,
  FILE_KIND_LABELS,
  actionCatalog,
  actionTree,
  arrange,
  colorizeActions,
  customTree,
  partEntries,
} from "../wheel/actions";
import { DEFAULT_ACCENT } from "../wheel/color";
import {
  type BuiltinMode,
  type Mode,
  OUTPUT_FORMATS,
  VIDEO_FORMATS,
  WEB_ICON,
  type WheelItem,
  colorize,
  customMode,
  isCustomMode,
  shareIcon,
} from "../wheel/formats";
import { MAX_SECTORS, SECTOR_COUNT } from "../wheel/geometry";
import { ModeIcon } from "../wheel/Wheel";
import { recordShortcut } from "./accelerator";
import { BubbleGroup } from "./Bubble";
import {
  AddRow,
  type Change,
  DragHandle,
  type Errors,
  ItemIcon,
  Row,
  SLIDER_COMMIT_MS,
  Section,
  type SectionId,
  Slider,
  Toggle,
} from "./controls";
import { CustomTab } from "./CustomTab";
import { PartPicker } from "./PartPicker";
import { PartChip, viewsOf } from "./parts";
import { moved, useSortable } from "./useSortable";
import { WheelPreview } from "./WheelPreview";
import "./settings.css";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "Général" },
  { id: "wheels", label: "Roues" },
  { id: "conversion", label: "Conversion" },
  { id: "colors", label: "Couleurs" },
  { id: "actions", label: "Actions" },
  { id: "apps", label: "Apps" },
  { id: "share", label: "Partage" },
  { id: "custom", label: "Mes roues" },
];

/** Dans l'onglet Actions : ce qu'ouvre un fichier selon son type. */
const FILE_WHEELS_ANCHOR = "selon-le-fichier";

const MODE_LABELS: Record<BuiltinMode, string> = {
  image: "Convertisseur d'images",
  video: "Convertisseur de vidéos",
  apps: "Applications",
  share: "Partage",
  actions: "Actions",
};

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
    wheelOrder: [],
    rememberWheel: false,
    dwellMs: 1000,
    formatColors: {},
    highlightColor: null,
    wheelBorder: "none",
    wheelBorderColor: null,
    wheelGlass: true,
    captureReopen: true,
    customWheels: [
      {
        id: "r1",
        name: "Boulot",
        enabled: true,
        parts: [
          { name: "PNG", kind: "convert", value: "png" },
          { name: "WebP", kind: "convert", value: "webp", color: "#ec4899" },
          { name: "Capture", kind: "action", value: "action-capture" },
          { name: "YouTube", kind: "url", value: "https://youtube.com/" },
        ],
        extensions: [],
      },
    ],
    actionParts: [],
    fileWheels: DEFAULT_FILE_WHEELS,
    apps: [
      { path: "/Applications/Finder.app", name: "Finder", kind: "app" },
      { path: "https://youtube.com/", name: "YouTube", kind: "url" },
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
  version: "1.5.0",
  apps: [
    { path: "/Applications/Finder.app", name: "Finder", kind: "app", icon: null },
    { path: "https://youtube.com/", name: "YouTube", kind: "url", icon: null },
    null,
    null,
    null,
    null,
  ],
  share: PREVIEW_SHARE,
  custom: [],
  tab: null,
};

const PERMISSION_TEXT: Record<NonNullable<SettingsView["finderPermission"]>, string> = {
  granted: "Autorisée",
  denied: "Refusée",
  notAsked: "Demandée à la première utilisation",
  unknown: "Inconnue",
};

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
          <p>Images, vidéos, apps et partage sur une roue radiale · version {view.version}</p>
        </div>
      </header>

      <BubbleGroup as="nav" className="settings-tabs" role="tablist" label="Réglages" selected={tab}>
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
            <span>{label}</span>
          </button>
        ))}
      </BubbleGroup>

      <div
        key={tab}
        className="settings-panel"
        data-direction={direction.current}
        role="tabpanel"
        aria-label={TABS.find(({ id }) => id === tab)?.label}
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
      <Section
        title="Ouvrir la roue"
        error={errors.shortcut}
        note="Dans la roue, ← et → choisissent une part, Entrée la lance ; les chiffres 1 à 9 (0 pour la dixième) la lancent directement. ↑ et ↓ changent de roue, Échap la ferme."
      >
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

/** Roues dans l'ordre du clic au centre : celui des réglages, puis celles qu'il ne cite pas
 * encore (une roue tout juste créée). */
function wheelKeys(settings: Settings): Mode[] {
  const known: Mode[] = [
    ...settings.modes.map((entry) => entry.id),
    ...settings.customWheels.map((wheel) => customMode(wheel.id)),
  ];
  const ordered = settings.wheelOrder.filter(
    (key, index, all) => known.includes(key) && all.indexOf(key) === index,
  );
  return [...ordered, ...known.filter((key) => !ordered.includes(key))];
}

/** Ce que fait chaque réglage « S'ouvre sur », en quelques mots. */
const FIRST_WHEEL_NAMES: Record<FirstWheel, string> = {
  convert: "convertisseur",
  actions: "roue Actions",
  share: "partage",
  apps: "apps",
  usual: "première roue",
};

/** « Images, Vidéos : convertisseur · PDF, Archives, Autres : roue Actions ». */
function fileWheelsSummary(fileWheels: FileWheels): string {
  const groups = new Map<FirstWheel, string[]>();
  for (const kind of FILE_KINDS) {
    const { first } = fileWheels[kind];
    groups.set(first, [...(groups.get(first) ?? []), FILE_KIND_LABELS[kind]]);
  }
  return [...groups]
    .map(([first, kinds]) => `${kinds.join(", ")} : ${FIRST_WHEEL_NAMES[first]}`)
    .join(" · ");
}

/** Ligne de la liste des roues : une roue de Rutile ou une roue personnalisée. */
type WheelRow = {
  key: Mode;
  label: string;
  hint?: string;
  custom: boolean;
  enabled: boolean;
  /** Affichée quels que soient les fichiers. */
  always: boolean;
  toggle: (next: boolean) => void;
};

function WheelsTab({
  settings,
  error,
  change,
  goTo,
}: {
  settings: Settings;
  error?: string;
  change: Change;
  goTo: (tab: SettingsTab, anchor?: string) => void;
}) {
  const keys = wheelKeys(settings);
  const sortable = useSortable(keys.length, (from, to) =>
    change("wheels", { wheelOrder: moved(keys, from, to) }),
  );
  const rows = keys.flatMap((key): WheelRow[] => {
    if (!isCustomMode(key)) {
      const enabled = settings.modes.some((entry) => entry.id === key && entry.enabled);
      const toggle = (next: boolean) => change("wheels", { modes: withMode(settings, key, next) });
      return [{ key, label: MODE_LABELS[key], hint: undefined, custom: false, enabled, always: enabled, toggle }];
    }
    const wheel = settings.customWheels.find((known) => customMode(known.id) === key);
    if (!wheel) return [];
    const count = wheel.parts.length;
    const toggle = (next: boolean) =>
      change("wheels", {
        customWheels: settings.customWheels.map((known) =>
          known === wheel ? { ...known, enabled: next } : known,
        ),
      });
    return [
      {
        key,
        label: wheel.name || "Roue sans nom",
        hint:
          count === 0
            ? "Roue perso · vide, elle n'apparaît pas encore"
            : `Roue perso · ${count} part${count > 1 ? "s" : ""}`,
        custom: true,
        enabled: wheel.enabled,
        // Affichée quels que soient les fichiers : elle peut rester la seule roue
        always: wheel.enabled && count > 0 && wheel.extensions.length === 0,
        toggle,
      },
    ];
  });
  const alwaysShown = rows.filter((row) => row.always).length;

  return (
    <>
      <Section
        title="Roues"
        error={error}
        sorting={sortable.sorting}
        note="Un clic au centre (ou ↓ au clavier) passe à la roue suivante, dans cet ordre. Glissez une ligne par sa poignée pour la déplacer."
      >
        {rows.map((row, index) => (
          <Row
            key={row.key}
            label={row.label}
            hint={row.hint}
            icon={<ModeIcon mode={row.key} size={22} />}
            sortable={sortable.row(index)}
            handle={<DragHandle label={row.label} {...sortable.handle(index)} />}
          >
            {row.custom && (
              <button
                type="button"
                className="link-button"
                onClick={() => goTo("custom", row.key.slice("custom:".length))}
              >
                Modifier
              </button>
            )}
            <Toggle
              checked={row.enabled}
              label={row.label}
              // La dernière roue toujours affichée ne peut pas être désactivée
              disabled={row.always && alwaysShown === 1}
              onChange={row.toggle}
            />
          </Row>
        ))}
        <AddRow label="Créer ma propre roue…" onClick={() => goTo("custom")} />
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
        <Row
          label="Roue ouverte par un fichier"
          hint={`${fileWheelsSummary(settings.fileWheels)}.`}
        >
          <button
            type="button"
            className="link-button"
            onClick={() => goTo("actions", FILE_WHEELS_ANCHOR)}
          >
            Régler…
          </button>
        </Row>
      </Section>
    </>
  );
}

function withMode(settings: Settings, mode: BuiltinMode, enabled: boolean): Settings["modes"] {
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
      <Section
        title="Qualité des formats avec perte"
        error={error}
        note="Plus la qualité est haute, plus le fichier est lourd."
      >
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

/** Roue dont on règle les couleurs : une roue de Rutile, ou une roue perso (`custom`, son
 * rang dans les réglages). */
type ColorWheel = { key: Mode; title: string; custom: number | null };

/** Couleurs proposées d'un clic : celles d'origine des parts. Toute autre se choisit dans le
 * sélecteur du système. */
const PALETTE: { color: string; name: string }[] = [
  { color: "#3b82f6", name: "Bleu" },
  { color: "#0d9488", name: "Turquoise" },
  { color: "#16a34a", name: "Vert" },
  { color: "#f2b705", name: "Jaune" },
  { color: "#f97316", name: "Orange" },
  { color: "#e5484d", name: "Rouge" },
  { color: "#ec4899", name: "Rose" },
  { color: "#8b5cf6", name: "Violet" },
  { color: "#64748b", name: "Ardoise" },
  { color: "#6b7280", name: "Gris" },
];

/** Ce dont on règle la couleur quand ce n'est pas une part : la surbrillance. */
const HIGHLIGHT = "highlight";

type ColorDraft = {
  colors: Record<string, string>;
  highlight: string | null;
  border: WheelBorder;
  borderColor: string | null;
  /** Couleur propre de chaque part des roues perso : par roue, dans l'ordre de ses parts. */
  parts: Record<string, (string | null)[]>;
};

/** Couleurs propres des parts des roues perso, telles qu'enregistrées. */
function partColors(wheels: readonly CustomWheel[]): ColorDraft["parts"] {
  return Object.fromEntries(
    wheels.map((wheel) => [wheel.id, wheel.parts.map((part) => part.color ?? null)]),
  );
}

/** Les roues perso telles qu'on les affiche, avec les couleurs propres de `parts`. */
function withPartColors(
  custom: readonly CustomWheelView[],
  parts: ColorDraft["parts"],
): CustomWheelView[] {
  return custom.map((wheel) => ({
    ...wheel,
    parts: wheel.parts.map((part, slot) => ({ ...part, color: parts[wheel.id]?.[slot] ?? null })),
  }));
}

/** Rang d'une part de roue perso, d'après l'identifiant de sa part sur la roue. */
const slotOf = (id: string) => Number(id.split("-")[2]);

const BORDERS: { id: WheelBorder; label: string }[] = [
  { id: "none", label: "Aucun" },
  { id: "light", label: "Clair" },
  { id: "dark", label: "Noir" },
  { id: "color", label: "Couleur" },
];

function ColorsTab({
  view,
  custom,
  error,
  change,
  goTo,
}: {
  view: SettingsView;
  /** Roues perso telles qu'elles s'affichent, avec les icônes de leurs parts. */
  custom: readonly CustomWheelView[];
  error?: string;
  change: Change;
  goTo: (tab: SettingsTab, anchor?: string) => void;
}) {
  const { settings } = view;
  // Les couleurs s'appliquent à l'aperçu tout de suite, et s'enregistrent un instant après
  const { formatColors, highlightColor, wheelBorder, wheelBorderColor, customWheels } = settings;
  const saved = (): ColorDraft => ({
    colors: formatColors,
    highlight: highlightColor,
    border: wheelBorder,
    borderColor: wheelBorderColor,
    parts: partColors(customWheels),
  });
  const [draft, setDraft] = useState<ColorDraft>(saved);
  const timer = useRef<number | undefined>(undefined);
  useEffect(
    () => setDraft(saved()),
    [formatColors, highlightColor, wheelBorder, wheelBorderColor, customWheels],
  );

  const update = (next: ColorDraft) => {
    setDraft(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () =>
        change("colors", {
          formatColors: next.colors,
          highlightColor: next.highlight,
          wheelBorder: next.border,
          wheelBorderColor: next.borderColor,
          customWheels: customWheels.map((wheel) => ({
            ...wheel,
            parts: wheel.parts.map((part, slot) => ({
              ...part,
              color: next.parts[wheel.id]?.[slot] ?? null,
            })),
          })),
        }),
      SLIDER_COMMIT_MS,
    );
  };

  // Roues de Rutile qui ont des couleurs, puis celles de l'utilisateur, sous leur nom
  const wheels: ColorWheel[] = [
    { key: "image", title: "Images", custom: null },
    { key: "video", title: "Vidéos", custom: null },
    { key: "actions", title: "Actions", custom: null },
    ...customWheels.map((wheel, index) => ({
      key: customMode(wheel.id),
      title: wheel.name || "Roue sans nom",
      custom: index,
    })),
  ];
  const [shown, setShown] = useState<Mode>("image");
  const wheel = wheels.find(({ key }) => key === shown) ?? wheels[0];

  const windowLayout = view.platform !== "linux" || !view.wayland;
  const actionParts = useMemo(
    () => actionTree({ windowLayout: true, actionParts: settings.actionParts }),
    [settings.actionParts],
  );
  // Parts de la roue affichée telles qu'à l'origine, puis à leurs couleurs. L'origine d'une
  // part perso est la couleur de son format ou de son action
  const [original, items]: [readonly WheelItem[], readonly WheelItem[]] = (() => {
    if (wheel.custom === null) {
      const parts =
        wheel.key === "actions" ? actionParts : wheel.key === "video" ? VIDEO_FORMATS : OUTPUT_FORMATS;
      return [parts, colorize(parts, draft.colors)];
    }
    const tree = (wheels: CustomWheelView[]) =>
      colorizeActions(customTree({ windowLayout, custom: wheels }, wheel.custom!), draft.colors);
    return [tree(withPartColors(custom, {})), tree(withPartColors(custom, draft.parts))];
  })();

  // Ce dont on règle la couleur : une part de la roue affichée, choisie d'un clic sur
  // l'aperçu, ou la surbrillance par son centre. La première part l'est d'emblée, pour que
  // les couleurs proposées soient sous les yeux dès l'arrivée
  const [target, setTarget] = useState<string>("");
  const selected =
    target === HIGHLIGHT ? -1 : Math.max(items.findIndex(({ id }) => id === target), 0);
  const part = target === HIGHLIGHT ? null : (items[selected] ?? null);
  const origin = part ? (original[selected]?.color ?? DEFAULT_ACCENT) : DEFAULT_ACCENT;
  const current = part ? (part.color ?? origin) : (draft.highlight ?? DEFAULT_ACCENT);
  // Une app, un dossier ou un site montre son icône : sa couleur ne se verrait pas
  const colorable = !part?.icon;

  const setHighlight = (color: string) =>
    update({ ...draft, highlight: color === DEFAULT_ACCENT ? null : color });
  const setColor = (color: string) => {
    if (!part) {
      setHighlight(color);
      return;
    }
    // Revenir à la couleur d'origine retire le choix, plutôt que de l'enregistrer
    const chosen = color === origin ? null : color;
    if (wheel.custom !== null) {
      const id = customWheels[wheel.custom].id;
      const colors = [...(draft.parts[id] ?? [])];
      colors[slotOf(part.id)] = chosen;
      update({ ...draft, parts: { ...draft.parts, [id]: colors } });
      return;
    }
    const colors = { ...draft.colors };
    if (chosen === null) delete colors[part.id];
    else colors[part.id] = chosen;
    update({ ...draft, colors });
  };

  const borderColor = draft.borderColor ?? draft.highlight ?? DEFAULT_ACCENT;
  const setBorder = (border: WheelBorder) =>
    // La couleur du contour part de celle de la surbrillance
    update({ ...draft, border, borderColor: border === "color" ? borderColor : draft.borderColor });
  const customized =
    Object.keys(draft.colors).length > 0 ||
    draft.highlight !== null ||
    draft.border !== "none" ||
    Object.values(draft.parts).some((colors) => colors.some((color) => color !== null));
  const title = part ? `Couleur de ${part.label}` : "Couleur de surbrillance";
  const hint = !part
    ? "La part survolée, et l'anneau autour du bouton visé."
    : !colorable
      ? "Une app, un dossier ou un site garde son icône."
      : wheel.custom !== null
        ? `Cette part, sur cette roue seulement${(part as ActionNode).children ? " ; ses options en héritent" : ""}.`
        : wheel.key === "actions"
          ? "La part, et les actions de sa sous-roue."
          : "La pastille de ce format, sur toutes les roues.";
  const customId = wheel.custom === null ? null : customWheels[wheel.custom].id;

  return (
    <>
      <Section title="Couleurs des parts" error={error}>
        <div className="color-preview">
          <BubbleGroup
            className="chips"
            role="tablist"
            label="Roue affichée"
            selected={`${wheel.key} ${wheels.map(({ title }) => title).join()}`}
          >
            {wheels.map(({ key, title }) => (
              <button
                key={key}
                type="button"
                role="tab"
                className="chip"
                aria-selected={key === wheel.key}
                onClick={() => {
                  setShown(key);
                  setTarget("");
                }}
              >
                <ModeIcon mode={key} size={14} />
                <span>{title}</span>
              </button>
            ))}
          </BubbleGroup>
          {items.length > 0 ? (
            <>
              <WheelPreview
                // Une nouvelle roue s'affiche sans glisser depuis la précédente
                key={wheel.key}
                mode={wheel.key}
                title={wheel.custom === null ? undefined : wheel.title}
                items={items}
                accent={draft.highlight}
                border={draft.border}
                borderColor={borderColor}
                glass={settings.wheelGlass}
                selected={part ? selected : null}
                partLabel={(item) => `Couleur de ${item.label}`}
                hubLabel="Couleur de surbrillance"
                onPart={(index) => setTarget(items[index].id)}
                onHub={() => setTarget(HIGHLIGHT)}
              />
              <p className="row-hint">
                Cliquez une part de la roue, ou son centre, puis choisissez sa couleur ci-dessous.
              </p>
            </>
          ) : (
            <div className="color-empty">
              <span className="color-empty-ring" aria-hidden="true">
                <WheelsIcon size={34} />
              </span>
              <p>« {wheel.title} » n'a pas encore de parts.</p>
              <button
                type="button"
                className="link-button"
                onClick={() => customId && goTo("custom", customId)}
              >
                Ajouter des parts…
              </button>
            </div>
          )}
        </div>
        <div className="color-inspector">
          <div className="color-inspector-head">
            <span
              className="color-well"
              data-icon={!colorable || undefined}
              style={colorable ? { background: current } : undefined}
              aria-hidden="true"
            >
              {!colorable && part?.icon && <img src={part.icon} alt="" />}
            </span>
            <div className="row-text">
              <span className="row-label">{title}</span>
              <span className="row-hint">{hint}</span>
            </div>
            {colorable && <span className="color-field-code">{current.toUpperCase()}</span>}
          </div>
          {colorable && (
            <Swatches label={title} current={current} original={origin} onPick={setColor} />
          )}
        </div>
      </Section>

      <Section title="Matière">
        <Row
          label="Liquid Glass"
          hint={
            view.nativeGlass
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
        <Row stacked label="Contour de la roue" hint="Le trait qui entoure le disque.">
          <BubbleGroup
            className="segmented segmented-fill"
            role="radiogroup"
            label="Contour de la roue"
            selected={draft.border}
          >
            {BORDERS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={draft.border === id}
                onClick={() => setBorder(id)}
              >
                {id === "none" ? (
                  <span className="border-sample" data-border="none" aria-hidden="true" />
                ) : (
                  <span
                    className="border-sample"
                    data-border={id}
                    style={id === "color" ? { borderColor } : undefined}
                    aria-hidden="true"
                  />
                )}
                {label}
              </button>
            ))}
          </BubbleGroup>
          {draft.border === "color" && (
            <Swatches
              label="Couleur du contour"
              current={borderColor}
              onPick={(color) => update({ ...draft, borderColor: color })}
            />
          )}
        </Row>
      </Section>

      <Section title="Surbrillance">
        <Row label="Part survolée" hint="Secteur éclairé et anneau autour du bouton visé.">
          <ColorField
            label="Part survolée"
            value={draft.highlight ?? DEFAULT_ACCENT}
            onChange={setHighlight}
          />
        </Row>
        <Row
          label="Couleurs d'origine"
          hint="Le texte des boutons reste lisible : blanc ou foncé selon la couleur."
        >
          <button
            type="button"
            className="shortcut-button"
            disabled={!customized}
            onClick={() =>
              update({
                colors: {},
                highlight: null,
                border: "none",
                borderColor: null,
                parts: Object.fromEntries(
                  Object.entries(draft.parts).map(([id, colors]) => [id, colors.map(() => null)]),
                ),
              })
            }
          >
            Réinitialiser
          </button>
        </Row>
      </Section>
    </>
  );
}

/** Pastilles de la palette, le sélecteur du système pour toute autre couleur, et le retour à
 * la couleur d'origine quand il y en a une. */
function Swatches({
  label,
  current,
  original,
  onPick,
}: {
  label: string;
  current: string;
  original?: string;
  onPick: (color: string) => void;
}) {
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {PALETTE.map(({ color, name }) => (
        <button
          key={color}
          type="button"
          role="radio"
          className="swatch"
          aria-checked={current === color}
          aria-label={name}
          title={name}
          style={{ background: color }}
          onClick={() => onPick(color)}
        />
      ))}
      <label
        className="swatch swatch-custom"
        title="Autre couleur…"
        data-current={!PALETTE.some(({ color }) => color === current) || undefined}
      >
        <input
          type="color"
          aria-label="Autre couleur"
          value={current}
          onChange={(event) => onPick(event.target.value.toLowerCase())}
        />
      </label>
      {original !== undefined && (
        <button
          type="button"
          className="link-button swatches-reset"
          disabled={current === original}
          onClick={() => onPick(original)}
        >
          D'origine
        </button>
      )}
    </div>
  );
}

/** Pastille de couleur qui ouvre le sélecteur du système, avec son code. */
function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
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
      <span className="color-field-code">{value.toUpperCase()}</span>
    </label>
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
      hint={item.action}
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
function firstChoices(
  kind: FileKind,
): { id: FirstWheel; label: string; mode: BuiltinMode | null }[] {
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

  const windowLayout = view.platform !== "linux" || !view.wayland;
  const rootParts = arrange(actionCatalog({ windowLayout }), settings.actionParts);
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
      <Section
        title="Roue Actions"
        error={errors.wheels}
        sorting={root.sorting}
        note="Glissez une part par sa poignée pour la déplacer : la première est en haut de la roue, les suivantes dans le sens des aiguilles d'une montre. Restez une seconde sur une part pour ouvrir ses options ; le centre ramène à la roue d'avant, comme Échap."
      >
        <WheelSwitch settings={settings} mode="actions" label="Afficher la roue Actions" change={change} />
        {root.rows}
      </Section>

      <Section
        id={FILE_WHEELS_ANCHOR}
        title="Selon le fichier"
        error={errors.actions}
        sorting={forFiles.sorting}
        note={`Un fichier secoué, glissé sur la roue ou sélectionné dans ${fileManager(view.platform)} ouvre la roue choisie. Sa roue Actions ne montre que ces actions, dans cet ordre, et seulement celles qui ont un sens (la fusion à partir de deux PDF) ; dix au plus. Plusieurs types mélangés comptent comme « Autres ».`}
      >
        <div className="kind-switch">
          <BubbleGroup
            className="segmented segmented-fill"
            role="tablist"
            label="Type de fichier"
            selected={kind}
          >
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
          </BubbleGroup>
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

    </>
  );
}

/** Ce que devient une part qui n'ouvre pas une app. */
const SLOT_KINDS: Record<Exclude<AppKind, "app">, string> = {
  folder: "Dossier",
  url: "Site web",
};

/** Ce qu'on peut poser sur la roue des apps. */
const APP_KINDS = ["app", "folder", "url"] as const;

function AppsTab({ view, errors, change }: { view: SettingsView; errors: Errors; change: Change }) {
  const { settings } = view;
  const count = settings.apps.length;
  const setApps = (apps: Settings["apps"]) => change("apps", { apps });
  const sortable = useSortable(count, (from, to) => setApps(moved(settings.apps, from, to)));
  // Part dont on choisit le contenu ; égale au nombre de parts, elle s'ajoute à la roue
  const [picking, setPicking] = useState<number | null>(null);
  const free = settings.apps.indexOf(null);

  const place = (slot: number, part: CustomPart) => {
    const apps = [...settings.apps];
    apps[slot] = { path: part.value, name: part.name, kind: part.kind as AppKind };
    setApps(apps);
  };

  // Au-delà de six parts, retirer une app retire sa part ; sinon la part reste, vide
  const remove = (slot: number) =>
    setApps(
      count > SECTOR_COUNT
        ? settings.apps.filter((_, i) => i !== slot)
        : settings.apps.map((app, i) => (i === slot ? null : app)),
    );
  const replaced = picking === null ? null : (settings.apps[picking] ?? null);

  return (
    <>
      <Section title="Roue des apps" error={errors.wheels}>
        <WheelSwitch settings={settings} mode="apps" label="Afficher la roue des apps" change={change} />
      </Section>
      <Section
        title="Applications"
        error={errors.apps}
        sorting={sortable.sorting}
        note={`Un clic sur une part lance l'application, ouvre le dossier ou le site ; un fichier déposé sur une application s'ouvre avec elle. La roue compte de ${SECTOR_COUNT} à ${MAX_SECTORS} parts.${
          view.platform === "macos"
            ? " Les pastilles de notifications du Dock s'affichent sur les icônes."
            : ""
        }`}
      >
        {settings.apps.map((_, slot) => {
          const app = view.apps[slot];
          const position = slotPosition(slot, count);
          return (
            <Row
              key={slot}
              label={app ? app.name : "Aucune application"}
              hint={app && app.kind !== "app" ? `${SLOT_KINDS[app.kind]} · ${position}` : position}
              muted={!app}
              // Un site dont le logo n'est pas (encore) connu garde le globe, comme sur la roue
              icon={
                <ItemIcon
                  icon={app?.icon ?? (app?.kind === "url" ? WEB_ICON : undefined)}
                  name={app?.name}
                />
              }
              sortable={sortable.row(slot)}
              handle={<DragHandle label={app?.name ?? position} {...sortable.handle(slot)} />}
            >
              <button type="button" className="link-button" onClick={() => setPicking(slot)}>
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
        {(free >= 0 || count < MAX_SECTORS) && (
          // Dans la première part libre, ou une part de plus
          <AddRow label="Ajouter une part" onClick={() => setPicking(free >= 0 ? free : count)} />
        )}
      </Section>
      {view.dockAccess !== null && (
        <Section title="Pastilles de notifications">
          <DockBadgesRow allowed={view.dockAccess} />
        </Section>
      )}
      {picking !== null && (
        <PartPicker
          title={replaced ? `Changer ${replaced.name}` : "Nouvelle part"}
          kinds={APP_KINDS}
          current={replaced && { kind: replaced.kind, name: replaced.name, value: replaced.path }}
          colors={settings.formatColors}
          windowLayout
          onPick={(part) => {
            place(picking, part);
            setPicking(null);
          }}
          onCancel={() => setPicking(null)}
        />
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
      <Section
        title="Destinations"
        error={errors.share}
        sorting={sortable.sorting}
        note={`${
          view.platform === "macos"
            ? "« Partager… » ouvre le menu de partage de macOS : choisissez l'app, puis le destinataire. AirDrop, Messages et Mail ouvrent directement leur fenêtre d'envoi. "
            : ""
        }Un dossier synchronisé (Google Drive, iCloud Drive…) reçoit une copie, que son app met en ligne. Pour Signal et les messageries sans partage, le fichier est copié puis l'app s'ouvre : collez-le avec ${paste} dans la conversation.`}
      >
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
