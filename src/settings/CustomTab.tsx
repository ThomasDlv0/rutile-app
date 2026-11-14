import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { WheelsIcon } from "../WheelsIcon";
import type {
  CustomPart,
  CustomWheel,
  CustomWheelView,
  PartKind,
  Settings,
  SettingsView,
} from "../ipc";
import { type ActionNode, colorizeActions, customTree } from "../wheel/actions";
import { customMode } from "../wheel/formats";
import { MAX_SECTORS } from "../wheel/geometry";
import { AddRow, type Change, DragHandle, ItemIcon, Row, Section, Toggle } from "./controls";
import { PartPicker } from "./PartPicker";
import { PartIcon, partHint } from "./parts";
import { moved, useSortable } from "./useSortable";
import { parseExtensions } from "./web";
import { WheelPreview } from "./WheelPreview";

/** Temps laissé pour confirmer la suppression d'une roue. */
const CONFIRM_MS = 4000;
/** Taille des roues de la galerie, par rapport à la vraie. */
const TILE_SCALE = 0.3;

/** Premier identifiant libre, comme Rust les attribue : « r1 », « r2 »… */
function freshId(wheels: readonly CustomWheel[]): string {
  for (let number = 1; ; number++) {
    const id = `r${number}`;
    if (!wheels.some((wheel) => wheel.id === id)) return id;
  }
}

/** Parts d'une roue perso, à leurs couleurs, telles que la roue les dessine. */
function useWheelNodes(
  custom: readonly CustomWheelView[],
  index: number,
  windowLayout: boolean,
  colors: Settings["formatColors"],
): ActionNode[] {
  return useMemo(
    () => colorizeActions(customTree({ windowLayout, custom: [...custom] }, index), colors),
    [custom, index, windowLayout, colors],
  );
}

/** « 4 parts », « Vide ». */
function partCount(count: number): string {
  return count === 0 ? "Vide" : `${count} part${count > 1 ? "s" : ""}`;
}

/** Les roues de l'utilisateur : une galerie pour les voir toutes d'un coup d'œil, puis
 * l'éditeur de celle qu'on ouvre. Chacune prend sa place parmi les roues de Rutile. */
export function CustomTab({
  view,
  custom,
  openWheel = null,
  error,
  change,
}: {
  view: SettingsView;
  /** Les mêmes roues telles qu'elles s'affichent, avec les icônes de leurs parts. */
  custom: readonly CustomWheelView[];
  /** Roue à ouvrir d'emblée, par son identifiant (« Modifier » dans l'onglet Roues). */
  openWheel?: string | null;
  error?: string;
  change: Change;
}) {
  const { settings } = view;
  const wheels = settings.customWheels;
  const setWheels = (customWheels: CustomWheel[]) => change("custom", { customWheels });
  const kinds: PartKind[] = [
    "app",
    "folder",
    "url",
    "convert",
    "action",
    // Les Raccourcis n'existent que sur macOS
    ...(view.platform === "macos" ? (["shortcut"] as const) : []),
    "command",
  ];
  const windowLayout = view.platform !== "linux" || !view.wayland;

  // Roue ouverte dans l'éditeur ; `null` : la galerie
  const [open, setOpen] = useState<string | null>(openWheel);
  // L'éditeur arrive de la droite, la galerie revient de la gauche ; rien ne glisse à
  // l'arrivée sur l'onglet, qui a déjà sa propre animation
  const [direction, setDirection] = useState<"forward" | "back" | null>(null);
  const openAt = (id: string | null, towards: "forward" | "back" = id ? "forward" : "back") => {
    setDirection(towards);
    setOpen(id);
    window.scrollTo({ top: 0 });
  };
  const index = wheels.findIndex((wheel) => wheel.id === open);

  const create = () => {
    const id = freshId(wheels);
    setWheels([
      ...wheels,
      {
        id,
        name: wheels.length === 0 ? "Ma roue" : `Ma roue ${wheels.length + 1}`,
        enabled: true,
        parts: [],
        extensions: [],
      },
    ]);
    openAt(id);
  };

  if (wheels.length === 0) {
    return (
      <section className="settings-section">
        <div className="settings-card empty-state">
          <WheelsIcon size={52} />
          <h3>Composez votre roue</h3>
          <p>
            Apps, dossiers, sites web, conversions, actions : posez ce que vous voulez sur une
            même roue. Elle prend ensuite sa place parmi les autres, au clic sur le centre.
          </p>
          <button type="button" className="primary-button" onClick={create}>
            Créer ma roue
          </button>
        </div>
        {error && (
          <p className="section-error" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  if (index < 0) {
    return (
      <div className="subpage" data-direction={direction ?? undefined}>
        <Section
          title={`Mes roues · ${wheels.length}`}
          error={error}
          note="Ouvrez une roue pour la composer. Leur ordre, au clic sur le centre, se règle dans l'onglet Roues."
        >
          <div className="wheel-gallery">
            {wheels.map((wheel, position) => (
              <WheelTile
                key={wheel.id}
                wheel={wheel}
                index={position}
                custom={custom}
                windowLayout={windowLayout}
                settings={settings}
                onOpen={() => openAt(wheel.id)}
              />
            ))}
            {wheels.length < MAX_SECTORS && (
              <button type="button" className="wheel-tile wheel-tile-new" onClick={create}>
                <span className="wheel-tile-disk wheel-tile-plus" aria-hidden="true">
                  +
                </span>
                <span className="wheel-tile-name">Nouvelle roue</span>
                <span className="wheel-tile-meta">
                  {MAX_SECTORS - wheels.length === 1
                    ? "Une place libre"
                    : `${MAX_SECTORS - wheels.length} places libres`}
                </span>
              </button>
            )}
          </div>
        </Section>
      </div>
    );
  }

  const wheel = wheels[index];
  return (
    <div key={wheel.id} className="subpage" data-direction={direction ?? undefined}>
      <div className="editor-bar">
        <button type="button" className="back-button" onClick={() => openAt(null)}>
          <svg width="8" height="13" viewBox="0 0 8 13" aria-hidden="true">
            <path d="M6.5 1.5 1.5 6.5l5 5" />
          </svg>
          Mes roues
        </button>
        {wheels.length > 1 && (
          <div className="editor-steps" role="group" aria-label="Autres roues">
            <button
              type="button"
              className="step-button"
              aria-label="Roue précédente"
              disabled={index === 0}
              onClick={() => openAt(wheels[index - 1].id, "back")}
            >
              <svg width="8" height="13" viewBox="0 0 8 13" aria-hidden="true">
                <path d="M6.5 1.5 1.5 6.5l5 5" />
              </svg>
            </button>
            <span className="editor-count">
              {index + 1} / {wheels.length}
            </span>
            <button
              type="button"
              className="step-button"
              aria-label="Roue suivante"
              disabled={index === wheels.length - 1}
              onClick={() => openAt(wheels[index + 1].id)}
            >
              <svg width="8" height="13" viewBox="0 0 8 13" aria-hidden="true">
                <path d="m1.5 1.5 5 5-5 5" />
              </svg>
            </button>
          </div>
        )}
      </div>
      <WheelEditor
        wheel={wheel}
        index={index}
        custom={custom}
        kinds={kinds}
        windowLayout={windowLayout}
        view={view}
        error={error}
        onChange={(next) => setWheels(wheels.map((known, i) => (i === index ? next : known)))}
        onRemove={() => {
          setWheels(wheels.filter((_, i) => i !== index));
          openAt(null);
        }}
      />
    </div>
  );
}

/** Une roue de la galerie : son aperçu réduit, son nom et ce qu'elle contient. */
function WheelTile({
  wheel,
  index,
  custom,
  windowLayout,
  settings,
  onOpen,
}: {
  wheel: CustomWheel;
  index: number;
  custom: readonly CustomWheelView[];
  windowLayout: boolean;
  settings: Settings;
  onOpen: () => void;
}) {
  const nodes = useWheelNodes(custom, index, windowLayout, settings.formatColors);
  const meta = [
    partCount(wheel.parts.length),
    ...(wheel.extensions.length > 0 ? [wheel.extensions.slice(0, 3).join(", ")] : []),
  ].join(" · ");
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  };
  return (
    // Pas un <button> : l'aperçu contient lui-même des boutons, rendus inertes
    <div
      className="wheel-tile"
      role="button"
      tabIndex={0}
      aria-label={`Ouvrir ${wheel.name || "la roue sans nom"}`}
      data-off={!wheel.enabled || undefined}
      onClick={onOpen}
      onKeyDown={onKeyDown}
    >
      {nodes.length > 0 ? (
        <div className="wheel-tile-disk" inert>
          <WheelPreview
            mode={customMode(wheel.id)}
            title={wheel.name}
            items={nodes}
            accent={settings.highlightColor}
            border={settings.wheelBorder}
            borderColor={settings.wheelBorderColor ?? settings.highlightColor}
            glass={settings.wheelGlass}
            scale={TILE_SCALE}
            partLabel={(item) => item.label}
            onPart={() => {}}
          />
        </div>
      ) : (
        <span className="wheel-tile-disk wheel-tile-empty" aria-hidden="true">
          <WheelsIcon size={30} />
        </span>
      )}
      <span className="wheel-tile-name">{wheel.name || "Roue sans nom"}</span>
      <span className="wheel-tile-meta">{meta}</span>
      {!wheel.enabled && <span className="wheel-tile-badge">Masquée</span>}
    </div>
  );
}

/** Une roue de l'utilisateur : son aperçu, son nom, ses parts dans l'ordre, et les fichiers
 * qu'elle concerne. */
function WheelEditor({
  wheel,
  index,
  custom,
  kinds,
  windowLayout,
  view,
  error,
  onChange,
  onRemove,
}: {
  wheel: CustomWheel;
  index: number;
  custom: readonly CustomWheelView[];
  kinds: readonly PartKind[];
  windowLayout: boolean;
  view: SettingsView;
  error?: string;
  onChange: (wheel: CustomWheel) => void;
  onRemove: () => void;
}) {
  const { settings } = view;
  const { parts } = wheel;
  // Part dont on choisit le contenu ; égale au nombre de parts, elle s'ajoute
  const [picking, setPicking] = useState<number | null>(null);
  const nodes = useWheelNodes(custom, index, windowLayout, settings.formatColors);
  // Une part d'une autre version, que cette roue ne sait pas afficher, n'a pas de nœud
  const nodeOf = (slot: number) => nodes.find((node) => node.id === `custom-${index}-${slot}`);
  const slotOf = (id: string) => Number(id.split("-")[2]);
  const sortable = useSortable(parts.length, (from, to) =>
    onChange({ ...wheel, parts: moved(parts, from, to) }),
  );
  // Une roue toute neuve attend son nom : le champ est prêt à être tapé
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (parts.length === 0 && /^Ma roue( \d+)?$/.test(wheel.name)) name.current?.select();
    // Seulement à l'ouverture de la roue
  }, [wheel.id]);

  const setPart = (slot: number, part: CustomPart) => {
    const next = [...parts];
    next[slot] = part;
    onChange({ ...wheel, parts: next });
  };
  const full = parts.length >= MAX_SECTORS;

  return (
    <>
      <Section
        title={wheel.name || "Roue sans nom"}
        error={error}
        sorting={sortable.sorting}
        action={<ConfirmButton label="Supprimer la roue" onConfirm={onRemove} />}
        note={
          parts.length === 0
            ? "Tant qu'elle est vide, la roue n'apparaît pas parmi les autres."
            : "Glissez une part par sa poignée pour la déplacer : la première est en haut de la roue, les suivantes dans le sens des aiguilles d'une montre. Dix parts au plus ; leurs couleurs se règlent dans l'onglet Couleurs."
        }
      >
        <div className="wheel-builder">
          {nodes.length > 0 ? (
            <>
              <WheelPreview
                mode={customMode(wheel.id)}
                title={wheel.name}
                items={nodes}
                accent={settings.highlightColor}
                border={settings.wheelBorder}
                borderColor={settings.wheelBorderColor ?? settings.highlightColor}
                glass={settings.wheelGlass}
                partLabel={(item) => item.action ?? item.label}
                onPart={(part) => setPicking(slotOf(nodes[part].id))}
              />
              <p className="row-hint">Voici votre roue. Cliquez une part pour la changer.</p>
            </>
          ) : (
            <button type="button" className="wheel-empty" onClick={() => setPicking(parts.length)}>
              <span className="wheel-empty-plus" aria-hidden="true">
                +
              </span>
              <span>Ajouter une première part</span>
            </button>
          )}
        </div>
        <Row label="Nom de la roue">
          <input
            ref={name}
            className="text-input"
            aria-label="Nom de la roue"
            maxLength={30}
            defaultValue={wheel.name}
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (name && name !== wheel.name) onChange({ ...wheel, name });
              else event.target.value = wheel.name;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </Row>
        {parts.map((part, slot) => {
          const node = nodeOf(slot);
          const label = node?.label ?? (part.name || "Part inconnue");
          return (
            <Row
              key={slot}
              label={label}
              hint={node ? partHint(part, node) : "Indisponible sur cet ordinateur"}
              muted={!node}
              icon={node ? <PartIcon item={node} /> : <ItemIcon name="?" />}
              sortable={sortable.row(slot)}
              handle={<DragHandle label={label} {...sortable.handle(slot)} />}
            >
              <button type="button" className="link-button" onClick={() => setPicking(slot)}>
                Changer…
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => onChange({ ...wheel, parts: parts.filter((_, i) => i !== slot) })}
              >
                Retirer
              </button>
            </Row>
          );
        })}
        {!full && parts.length > 0 && (
          <AddRow label="Ajouter une part" onClick={() => setPicking(parts.length)} />
        )}
      </Section>

      <Section title="Affichage">
        <Row
          label="Afficher cette roue"
          hint="Sa place parmi les autres se règle dans l'onglet Roues."
        >
          <Toggle
            checked={wheel.enabled}
            label={`Afficher ${wheel.name}`}
            onChange={(enabled) => onChange({ ...wheel, enabled })}
          />
        </Row>
        <Row
          label="Seulement pour certains fichiers"
          hint={
            wheel.extensions.length > 0
              ? "Elle n'apparaît que si tous les fichiers ont une de ces extensions."
              : "Laissez vide pour qu'elle apparaisse toujours."
          }
        >
          <input
            className="text-input extensions-input"
            aria-label="Extensions des fichiers concernés"
            placeholder="pdf, docx…"
            autoCapitalize="off"
            spellCheck={false}
            defaultValue={wheel.extensions.join(", ")}
            onBlur={(event) => {
              const extensions = parseExtensions(event.target.value);
              event.target.value = extensions.join(", ");
              if (extensions.join() !== wheel.extensions.join()) onChange({ ...wheel, extensions });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </Row>
      </Section>

      {picking !== null && (
        <PartPicker
          title={picking < parts.length ? "Changer la part" : "Nouvelle part"}
          kinds={kinds}
          current={parts[picking] ?? null}
          colors={settings.formatColors}
          windowLayout={windowLayout}
          onPick={(part) => {
            setPart(picking, part);
            setPicking(null);
          }}
          onCancel={() => setPicking(null)}
        />
      )}
    </>
  );
}

/** Bouton qui demande une confirmation : un second clic, dans les secondes qui suivent. */
function ConfirmButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const timer = window.setTimeout(() => setAsking(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [asking]);
  return (
    <button
      type="button"
      className="link-button"
      data-danger={asking || undefined}
      onClick={() => (asking ? onConfirm() : setAsking(true))}
    >
      {asking ? "Confirmer la suppression" : label}
    </button>
  );
}
