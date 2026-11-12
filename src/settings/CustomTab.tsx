import { useEffect, useMemo, useState } from "react";
import { WheelsIcon } from "../WheelsIcon";
import type { CustomPart, CustomWheel, CustomWheelView, PartKind, SettingsView } from "../ipc";
import { colorizeActions, customTree } from "../wheel/actions";
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

/** Premier identifiant libre, comme Rust les attribue : « r1 », « r2 »… */
function freshId(wheels: readonly CustomWheel[]): string {
  for (let number = 1; ; number++) {
    const id = `r${number}`;
    if (!wheels.some((wheel) => wheel.id === id)) return id;
  }
}

/** Les roues de l'utilisateur : chacune mélange ce qu'il veut, et prend sa place parmi les
 * roues de Rutile. */
export function CustomTab({
  view,
  custom,
  error,
  change,
}: {
  view: SettingsView;
  /** Les mêmes roues telles qu'elles s'affichent, avec les icônes de leurs parts. */
  custom: readonly CustomWheelView[];
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

  const create = () =>
    setWheels([
      ...wheels,
      {
        id: freshId(wheels),
        name: wheels.length === 0 ? "Ma roue" : `Ma roue ${wheels.length + 1}`,
        enabled: true,
        parts: [],
        extensions: [],
      },
    ]);

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

  return (
    <>
      {wheels.map((wheel, index) => (
        <WheelEditor
          key={wheel.id}
          wheel={wheel}
          index={index}
          custom={custom}
          kinds={kinds}
          windowLayout={windowLayout}
          view={view}
          error={index === 0 ? error : undefined}
          onChange={(next) => setWheels(wheels.map((known, i) => (i === index ? next : known)))}
          onRemove={() => setWheels(wheels.filter((_, i) => i !== index))}
        />
      ))}
      {wheels.length < MAX_SECTORS && (
        <section className="settings-section">
          <div className="settings-card">
            <AddRow label="Créer une autre roue" onClick={create} />
          </div>
        </section>
      )}
    </>
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
  const nodes = useMemo(
    () =>
      colorizeActions(customTree({ windowLayout, custom: [...custom] }, index), settings.formatColors),
    [custom, index, windowLayout, settings.formatColors],
  );
  // Une part d'une autre version, que cette roue ne sait pas afficher, n'a pas de nœud
  const nodeOf = (slot: number) => nodes.find((node) => node.id === `custom-${index}-${slot}`);
  const slotOf = (id: string) => Number(id.split("-")[2]);
  const sortable = useSortable(parts.length, (from, to) =>
    onChange({ ...wheel, parts: moved(parts, from, to) }),
  );

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
            : "Glissez une part par sa poignée pour la déplacer : la première est en haut de la roue, les suivantes dans le sens des aiguilles d'une montre. Dix parts au plus."
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

      <Section title={`Affichage de « ${wheel.name || "la roue"} »`}>
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
