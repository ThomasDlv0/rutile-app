import { t } from "../i18n";
import type { CustomPart, CustomWheel, CustomWheelView } from "../ipc";
import { ActionGlyph } from "../wheel/ActionGlyph";
import type { ActionNode } from "../wheel/actions";
import { readableInk } from "../wheel/color";
import type { WheelItem } from "../wheel/formats";

/** Pastille d'une part de roue, à sa couleur : son pictogramme, ou son nom pour un format. */
export function PartChip({
  node,
  colors = {},
  large,
}: {
  node: Pick<ActionNode, "id" | "family" | "color" | "glyph" | "label">;
  /** Couleurs choisies dans les réglages, si la part n'est pas déjà à sa couleur. */
  colors?: Readonly<Record<string, string>>;
  large?: boolean;
}) {
  const color =
    colors[node.id] ?? (node.family !== undefined ? colors[node.family] : undefined) ?? node.color;
  return (
    <span
      className="part-chip"
      data-large={large || undefined}
      style={color ? { background: color, color: readableInk(color) } : undefined}
    >
      {node.glyph ? (
        <ActionGlyph name={node.glyph} size={large ? 19 : 15} />
      ) : (
        <span className="part-chip-text">{node.label}</span>
      )}
    </span>
  );
}

/** Icône d'une part dans une liste : celle de l'app, du dossier ou du site, sinon sa
 * pastille. */
export function PartIcon({ item }: { item: WheelItem }) {
  if (item.icon) return <img className="settings-app-icon" src={item.icon} alt="" />;
  return <PartChip node={item} large />;
}

/** Ce qu'est une part, sous son nom dans la liste. */
export function partHint(part: CustomPart, node: ActionNode | undefined): string {
  switch (part.kind) {
    case "app":
      return t("settings.kind.app");
    case "folder":
      return t("settings.kind.folder");
    case "url":
      return t("settings.parts.site", {
        site: part.value.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, ""),
      });
    case "convert":
      return node?.action ?? t("settings.kind.convert");
    case "action":
      if (!node) return t("settings.kind.action");
      return node.children
        ? t("settings.parts.withOptions", { action: node.action ?? "" })
        : (node.action ?? "");
    case "shortcut":
      return t("settings.parts.shortcut", { value: part.value });
    case "command":
      return t("settings.parts.command", { value: part.value });
  }
}

/** Roues personnalisées telles que la roue les affiche, sans leurs icônes : pour l'aperçu
 * dans un navigateur, où Rust n'est pas là pour les fournir. */
export function viewsOf(wheels: readonly CustomWheel[]): CustomWheelView[] {
  return wheels.map((wheel) => ({
    id: wheel.id,
    name: wheel.name,
    extensions: wheel.extensions,
    parts: wheel.parts.map((part) => ({
      name: part.name,
      kind: part.kind,
      value: part.kind === "convert" || part.kind === "action" ? part.value : null,
      icon: null,
      color: part.color ?? null,
    })),
  }));
}
