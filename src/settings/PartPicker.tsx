import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { pickApp, pickAppFolder, sitePreview, type CustomPart, type PartKind, type SitePreview } from "../ipc";
import { actionChoices } from "../wheel/actions";
import { OUTPUT_FORMATS, VIDEO_FORMATS, WEB_ICON, colorize } from "../wheel/formats";
import { ItemIcon } from "./controls";
import { PartChip } from "./parts";
import { siteName, webAddress } from "./web";

const KIND_LABELS: Record<PartKind, string> = {
  app: "Application",
  folder: "Dossier",
  url: "Site web",
  convert: "Conversion",
  action: "Action",
  shortcut: "Raccourci",
  command: "Commande",
};

/** Pictogrammes des genres de parts, au trait, comme ceux des onglets. */
const KIND_ICONS: Record<PartKind, ReactNode> = {
  app: (
    <>
      <rect x="3.2" y="3.2" width="5.6" height="5.6" rx="1.6" />
      <rect x="11.2" y="3.2" width="5.6" height="5.6" rx="1.6" />
      <rect x="3.2" y="11.2" width="5.6" height="5.6" rx="1.6" />
      <rect x="11.2" y="11.2" width="5.6" height="5.6" rx="1.6" />
    </>
  ),
  folder: <path d="M2.8 6.2a1.6 1.6 0 0 1 1.6-1.6h3.2l1.7 1.8h6.3a1.6 1.6 0 0 1 1.6 1.6v6.4a1.6 1.6 0 0 1-1.6 1.6H4.4a1.6 1.6 0 0 1-1.6-1.6Z" />,
  url: (
    <>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M2.8 10h14.4M10 2.8c-3.4 3.6-3.4 10.8 0 14.4M10 2.8c3.4 3.6 3.4 10.8 0 14.4" />
    </>
  ),
  convert: <path d="M4 7h11.5l-3-3M16 13H4.5l3 3" />,
  action: <path d="M11.4 2.6 4.3 11a.6.6 0 0 0 .5 1H9l-1 5.4 7-8.5a.6.6 0 0 0-.5-1h-4.1Z" />,
  shortcut: <path d="M10 3.2 3 7l7 3.8L17 7ZM3.4 10.4 10 14l6.6-3.6M3.4 13.4 10 17l6.6-3.6" />,
  command: (
    <>
      <rect x="2.8" y="3.8" width="14.4" height="12.4" rx="2.2" />
      <path d="m6 8 2.4 2L6 12M10.4 12.4h3.4" />
    </>
  ),
};

// Aperçu dans un navigateur, sans Tauri : de quoi essayer chaque genre de part
const PREVIEW_PICKS: Record<"app" | "folder", CustomPart> = {
  app: { kind: "app", name: "Mail", value: "/Applications/Mail.app" },
  folder: { kind: "folder", name: "Projets", value: "/Users/moi/Projets" },
};

function previewSite(address: string): Promise<SitePreview> {
  const [word] = siteName(address).split(".").slice(-2);
  const name = word.charAt(0).toUpperCase() + word.slice(1);
  return new Promise((resolve) => window.setTimeout(() => resolve({ name, icon: null }), 500));
}

/** Délai après la dernière frappe avant de demander son logo au site. */
const SITE_LOOKUP_MS = 450;

/** Feuille de choix d'une part : une app, un dossier, un site, et pour une roue personnalisée
 * une conversion, une action, un raccourci ou une commande. */
export function PartPicker({
  title,
  kinds,
  current = null,
  colors,
  windowLayout,
  onPick,
  onCancel,
}: {
  title: string;
  /** Ce qu'on peut poser ici, dans l'ordre des tuiles. */
  kinds: readonly PartKind[];
  /** Part remplacée : son genre est ouvert d'emblée, ses champs repris. */
  current?: CustomPart | null;
  /** Couleurs choisies dans les réglages, pour les formats et les actions. */
  colors: Readonly<Record<string, string>>;
  /** Les fenêtres se rangent sur ce système. */
  windowLayout: boolean;
  onPick: (part: CustomPart) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<PartKind | null>(
    current && kinds.includes(current.kind) && current.kind !== "app" && current.kind !== "folder"
      ? current.kind
      : null,
  );
  const sheet = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useEffect(() => {
    sheet.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Une app ou un dossier se choisit dans le sélecteur du système, tout de suite
  const choose = async (chosen: PartKind) => {
    if (chosen !== "app" && chosen !== "folder") {
      setKind(chosen);
      return;
    }
    setKind(null);
    if (!isTauri()) {
      onPick(PREVIEW_PICKS[chosen]);
      return;
    }
    const picked = chosen === "app" ? await pickApp() : await pickAppFolder();
    if (picked) onPick({ kind: chosen, name: picked.name, value: picked.path });
  };

  const same = (wanted: PartKind) => (current?.kind === wanted ? current : null);

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div
        ref={sheet}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="sheet-title">{title}</h3>
        <div className="kind-grid" role="group" aria-label="Genre de part">
          {kinds.map((id) => (
            <button
              key={id}
              type="button"
              className="kind-tile"
              aria-pressed={kind === id}
              onClick={() => void choose(id)}
            >
              <svg className="tab-icon" width="24" height="24" viewBox="0 0 20 20" aria-hidden="true">
                {KIND_ICONS[id]}
              </svg>
              <span>{KIND_LABELS[id]}</span>
            </button>
          ))}
        </div>
        {kind === "url" && <SiteForm current={same("url")} onPick={onPick} />}
        {kind === "convert" && <FormatChoices colors={colors} onPick={onPick} />}
        {kind === "action" && (
          <ActionChoices colors={colors} windowLayout={windowLayout} onPick={onPick} />
        )}
        {kind === "shortcut" && (
          <NamedForm
            kind="shortcut"
            current={same("shortcut")}
            valueLabel="Nom du raccourci"
            placeholder="Tel qu'il s'appelle dans l'app Raccourcis"
            hint="Les fichiers de la roue lui sont passés en entrée."
            onPick={onPick}
          />
        )}
        {kind === "command" && (
          <NamedForm
            kind="command"
            current={same("command")}
            valueLabel="Commande"
            placeholder={'open -a Aperçu "$1"'}
            hint="Les fichiers de la roue sont ses arguments : $1, $2…"
            onPick={onPick}
          />
        )}
        <div className="sheet-actions">
          <button type="button" className="shortcut-button" onClick={onCancel}>
            Annuler
          </button>
        </div>
      </div>
    </div>
  );
}

/** Adresse d'un site : son nom et son logo arrivent pendant qu'on la tape. */
function SiteForm({
  current,
  onPick,
}: {
  current: CustomPart | null;
  onPick: (part: CustomPart) => void;
}) {
  const [address, setAddress] = useState(current?.value ?? "");
  // Tant que le nom n'est pas tapé à la main, il suit celui que donne le site. Un site ajouté
  // avant que Rutile sache le lui demander porte son adresse pour nom : il le suit aussi
  const [typedName, setTypedName] = useState<string | null>(
    current && current.name !== siteName(current.value) ? current.name : null,
  );
  const [found, setFound] = useState<{ address: string; site: SitePreview } | null>(null);
  const [looking, setLooking] = useState(false);
  const url = webAddress(address);

  useEffect(() => {
    if (!url) {
      setLooking(false);
      return;
    }
    let stale = false;
    setLooking(true);
    const timer = window.setTimeout(() => {
      (isTauri() ? sitePreview(url) : previewSite(url))
        .then((site) => !stale && setFound({ address: url, site }))
        .catch(() => {})
        .finally(() => !stale && setLooking(false));
    }, SITE_LOOKUP_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [url]);

  const site = url && found?.address === url ? found.site : null;
  const name = typedName ?? site?.name ?? (url ? siteName(url) : "");

  return (
    <form
      className="picker-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!url) return;
        onPick({ kind: "url", name: name.trim() || siteName(url), value: url });
      }}
    >
      <label className="picker-field">
        <span>Adresse</span>
        <input
          className="text-input"
          placeholder="youtube.com"
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
      </label>
      <div className="site-preview" data-waiting={!url || undefined}>
        <span className="site-preview-icon" data-looking={looking || undefined}>
          <ItemIcon icon={site?.icon ?? WEB_ICON} />
        </span>
        <input
          className="text-input"
          aria-label="Nom de la part"
          placeholder="Nom"
          maxLength={40}
          disabled={!url}
          value={name}
          onChange={(event) => setTypedName(event.target.value)}
        />
        <button type="submit" className="primary-button" disabled={!url}>
          {current ? "Enregistrer" : "Ajouter"}
        </button>
      </div>
      <p className="picker-hint">
        {looking
          ? "Recherche du logo…"
          : site && !site.icon
            ? "Ce site ne donne pas de logo : il gardera le globe."
            : "Le logo et le nom viennent du site lui-même."}
      </p>
    </form>
  );
}

/** Les formats des roues Images et Vidéo, en pastilles à leurs couleurs. */
function FormatChoices({
  colors,
  onPick,
}: {
  colors: Readonly<Record<string, string>>;
  onPick: (part: CustomPart) => void;
}) {
  const groups = [
    { title: "Images", formats: colorize(OUTPUT_FORMATS, colors) },
    { title: "Vidéos et son", formats: colorize(VIDEO_FORMATS, colors) },
  ];
  return (
    <div className="picker-panel">
      {groups.map(({ title, formats }) => (
        <div key={title} className="sheet-group">
          <h4>{title}</h4>
          <div className="format-choices">
            {formats.map((format) => (
              <button
                key={format.id}
                type="button"
                className="format-choice"
                style={{ background: format.color, color: format.ink }}
                title={format.action ?? `Convertir en ${format.label}`}
                onClick={() => onPick({ kind: "convert", name: format.label, value: format.id })}
              >
                {format.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <p className="picker-hint">
        La part convertit les fichiers de la roue, ou les fait choisir s'il n'y en a pas.
      </p>
    </div>
  );
}

/** Les actions de la roue Actions, rangées par part : la part entière, puis chacune des
 * siennes. */
function ActionChoices({
  colors,
  windowLayout,
  onPick,
}: {
  colors: Readonly<Record<string, string>>;
  windowLayout: boolean;
  onPick: (part: CustomPart) => void;
}) {
  const choices = useMemo(() => actionChoices({ windowLayout }), [windowLayout]);
  return (
    <div className="sheet-list picker-list">
      {choices.map(({ group, actions }) => (
        <div key={group.id} className="sheet-group">
          <h4>{group.label}</h4>
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="sheet-item"
              onClick={() => onPick({ kind: "action", name: action.label, value: action.id })}
            >
              <PartChip node={action} colors={colors} />
              <span className="sheet-item-text">
                <span>{action.label}</span>
                <span className="sheet-item-hint">
                  {action.children ? `${action.action} · avec ses options` : action.action}
                </span>
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Raccourci ou commande : un nom pour la part, et ce qu'elle lance. */
function NamedForm({
  kind,
  current,
  valueLabel,
  placeholder,
  hint,
  onPick,
}: {
  kind: "shortcut" | "command";
  current: CustomPart | null;
  valueLabel: string;
  placeholder: string;
  hint: string;
  onPick: (part: CustomPart) => void;
}) {
  const [name, setName] = useState(current?.name ?? "");
  const [value, setValue] = useState(current?.value ?? "");
  const ready = name.trim() !== "" && value.trim() !== "";
  return (
    <form
      className="picker-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onPick({ kind, name: name.trim(), value: value.trim() });
      }}
    >
      <label className="picker-field">
        <span>Nom de la part</span>
        <input
          className="text-input"
          placeholder="Ce qui s'affiche sur la roue"
          autoFocus
          maxLength={40}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="picker-field">
        <span>{valueLabel}</span>
        <input
          className="text-input"
          placeholder={placeholder}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <div className="picker-submit">
        <p className="picker-hint">{hint}</p>
        <button type="submit" className="primary-button" disabled={!ready}>
          {current ? "Enregistrer" : "Ajouter"}
        </button>
      </div>
    </form>
  );
}
