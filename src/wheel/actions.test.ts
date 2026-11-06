import { describe, expect, it } from "vitest";
import type { FileInfo } from "../ipc";
import {
  type ActionNode,
  actionParent,
  actionTree,
  actionsAt,
  colorizeActions,
  disabledActions,
  filesFor,
  opensOnDwell,
} from "./actions";
import { MAX_SECTORS } from "./geometry";

const file = (name: string, format: FileInfo["format"] = null, video: FileInfo["video"] = null) => ({
  path: `/tmp/${name}`,
  name,
  format,
  video,
});
const tree = actionTree({ custom: [], windowLayout: true });
const node = (id: string, nodes: readonly ActionNode[] = tree): ActionNode => {
  const found = nodes.find((item) => item.id === id);
  if (!found) throw new Error(`${id} introuvable`);
  return found;
};

function walk(nodes: readonly ActionNode[], visit: (item: ActionNode) => void) {
  for (const item of nodes) {
    visit(item);
    if (item.children) walk(item.children, visit);
  }
}

describe("actionTree", () => {
  it("tient sur une roue, sous-roues comprises", () => {
    expect(tree.length).toBeLessThanOrEqual(MAX_SECTORS);
    walk(tree, (item) => expect(item.children?.length ?? 0).toBeLessThanOrEqual(MAX_SECTORS));
  });

  it("donne un identifiant différent à chaque part", () => {
    const ids: string[] = [];
    walk(tree, (item) => ids.push(item.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a toujours quelque chose à faire au clic", () => {
    walk(tree, (item) =>
      expect(item.run ?? item.convert ?? item.children ?? item.goesTo ?? item.setup).toBeDefined(),
    );
  });

  it("retire les fenêtres quand le système ne sait pas les ranger", () => {
    const wayland = actionTree({ custom: [], windowLayout: false });
    expect(wayland.some((item) => item.id === "action-windows")).toBe(false);
  });

  it("garde un clic direct sur Capture, et des options en restant dessus", () => {
    const capture = node("action-capture");
    expect(capture.run).toEqual({ kind: "capture", target: "zone", delay: 0 });
    expect(opensOnDwell(capture)).toBe(true);
    expect(opensOnDwell(node("action-text"))).toBe(false);
  });

  it("envoie vers les réglages tant qu'il n'y a pas de roue personnalisée", () => {
    expect(node("action-custom").setup).toBe(true);
  });

  it("ouvre directement les actions d'une seule roue personnalisée", () => {
    const custom = actionTree({
      windowLayout: true,
      custom: [{ name: "Dev", actions: [{ name: "Build", kind: "command" }] }],
    });
    const part = node("action-custom", custom);
    expect(part.children?.map((item) => item.label)).toEqual(["Build"]);
    expect(part.children?.[0].run).toEqual({ kind: "custom", wheel: 0, action: 0 });
  });

  it("garde l'index d'origine d'une roue quand une roue vide la précède", () => {
    const custom = actionTree({
      windowLayout: true,
      custom: [
        { name: "Vide", actions: [] },
        { name: "Dev", actions: [{ name: "Build", kind: "command" }] },
      ],
    });
    expect(node("action-custom", custom).children?.[0].run).toEqual({
      kind: "custom",
      wheel: 1,
      action: 0,
    });
  });

  it("propose une roue par roue personnalisée s'il y en a plusieurs", () => {
    const custom = actionTree({
      windowLayout: true,
      custom: [
        { name: "Dev", actions: [{ name: "Build", kind: "command" }] },
        { name: "Maison", actions: [{ name: "Lampe", kind: "url" }] },
      ],
    });
    const part = node("action-custom", custom);
    expect(part.children?.map((item) => item.label)).toEqual(["Dev", "Maison"]);
    expect(part.children?.[1].children?.[0].run).toEqual({ kind: "custom", wheel: 1, action: 0 });
  });
});

describe("actionsAt", () => {
  it("suit le chemin des sous-roues", () => {
    const files = tree.findIndex((item) => item.id === "action-files");
    const rename = node("action-files").children!.findIndex((item) => item.id === "files-rename");
    expect(actionsAt(tree, [])).toBe(tree);
    expect(actionsAt(tree, [files])[0].id).toBe("files-zip");
    expect(actionsAt(tree, [files, rename])[0].id).toBe("rename-number");
    expect(actionParent(tree, [files, rename])?.id).toBe("files-rename");
    expect(actionParent(tree, [])).toBeNull();
  });

  it("reste sur la dernière roue valide si le chemin n'existe plus", () => {
    expect(actionsAt(tree, [999])).toBe(tree);
  });
});

describe("couleurs", () => {
  it("applique la couleur choisie à la part et à sa sous-roue", () => {
    const colored = colorizeActions(tree, { "action-files": "#123456" });
    const files = node("action-files", colored);
    expect(files.color).toBe("#123456");
    expect(files.children?.every((item) => item.color === "#123456")).toBe(true);
    expect(files.ink).toBeDefined();
  });
});

describe("fichiers", () => {
  const image = file("photo.png", "png");
  const video = file("clip.mp4", null, "mp4");
  const pdf = file("doc.PDF");

  it("grise les actions qui ne conviennent à aucun fichier", () => {
    const fichiers = node("action-files").children!;
    const disabled = disabledActions(fichiers, [video]);
    expect(disabled.has("files-pdf")).toBe(true);
    expect(disabled.has("files-merge")).toBe(true);
    expect(disabled.has("files-zip")).toBe(false);
    expect(disabled.has("files-rename")).toBe(false);
  });

  it("ne grise rien tant qu'aucun fichier n'est connu", () => {
    expect(disabledActions(node("action-image").children!, []).size).toBe(0);
  });

  it("ne garde que les fichiers qui conviennent à l'action", () => {
    const mixed = [image, video, pdf];
    const fichiers = node("action-files").children!;
    expect(filesFor(node("files-pdf", fichiers), mixed)).toEqual([image]);
    expect(filesFor(node("files-merge", fichiers), mixed)).toEqual([pdf]);
    expect(filesFor(node("files-zip", fichiers), mixed)).toEqual(mixed);
  });

  it("passe tous les fichiers de la roue à une action personnalisée", () => {
    const custom = actionTree({
      windowLayout: true,
      custom: [{ name: "Dev", actions: [{ name: "Build", kind: "command" }] }],
    });
    const build = node("action-custom", custom).children![0];
    expect(filesFor(build, [image, pdf])).toEqual([image, pdf]);
    expect(filesFor(build, [])).toEqual([]);
  });

  it("accepte un GIF parmi les vidéos", () => {
    const gif = file("anim.gif", "gif");
    expect(filesFor(node("video-gif", node("action-video").children!), [gif])).toEqual([gif]);
  });
});
