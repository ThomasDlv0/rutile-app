import { describe, expect, it } from "vitest";
import type { FileInfo } from "../ipc";
import {
  type ActionNode,
  DEFAULT_FILE_WHEELS,
  FILE_ACTIONS,
  actionCatalog,
  actionParent,
  actionTree,
  actionsAt,
  arrange,
  colorizeActions,
  disabledActions,
  fileKind,
  fileTree,
  filesFor,
  firstModeFor,
  opensOnDwell,
} from "./actions";
import { ALL_MODES } from "./formats";
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
      custom: [{ name: "Dev", actions: [{ name: "Build", kind: "command" }], extensions: [] }],
    });
    const part = node("action-custom", custom);
    expect(part.children?.map((item) => item.label)).toEqual(["Build"]);
    expect(part.children?.[0].run).toEqual({ kind: "custom", wheel: 0, action: 0 });
  });

  it("garde l'index d'origine d'une roue quand une roue vide la précède", () => {
    const custom = actionTree({
      windowLayout: true,
      custom: [
        { name: "Vide", actions: [], extensions: [] },
        { name: "Dev", actions: [{ name: "Build", kind: "command" }], extensions: [] },
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
        { name: "Dev", actions: [{ name: "Build", kind: "command" }], extensions: [] },
        { name: "Maison", actions: [{ name: "Lampe", kind: "url" }], extensions: [] },
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
      custom: [{ name: "Dev", actions: [{ name: "Build", kind: "command" }], extensions: [] }],
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

describe("ordre des parts", () => {
  const catalog = actionCatalog({ custom: [], windowLayout: true });

  it("suit l'ordre des réglages, et masque les parts éteintes", () => {
    const ordered = actionTree({
      custom: [],
      windowLayout: true,
      actionParts: [
        { id: "action-color", enabled: true },
        { id: "action-capture", enabled: false },
      ],
    });
    expect(ordered[0].id).toBe("action-color");
    expect(ordered.some((item) => item.id === "action-capture")).toBe(false);
    // Les parts que les réglages ne citent pas suivent, dans leur ordre d'origine
    expect(ordered[1].id).toBe("action-text");
    expect(ordered).toHaveLength(catalog.length - 1);
  });

  it("ignore une part qui n'existe plus", () => {
    const parts = arrange(catalog, [{ id: "action-disparue", enabled: true }]);
    expect(parts.map(({ item }) => item.id)).toEqual(catalog.map((item) => item.id));
  });

  it("garde masquée par défaut une action qui l'est, tant qu'on ne l'a pas réglée", () => {
    const images = arrange(FILE_ACTIONS.images, []);
    expect(images.find(({ item }) => item.id === "files-path")?.enabled).toBe(false);
    const shown = arrange(FILE_ACTIONS.images, [{ id: "files-path", enabled: true }]);
    expect(shown[0]).toMatchObject({ item: { id: "files-path" }, enabled: true });
  });
});

describe("roue d'un fichier", () => {
  const config = { custom: [], windowLayout: true, fileWheels: DEFAULT_FILE_WHEELS };
  const ids = (nodes: readonly ActionNode[]) => nodes.map((item) => item.id);
  const pdf = file("contrat.pdf");
  const image = file("photo.jpg", "jpeg");

  it("reconnaît le type des fichiers, un mélange comptant comme autre", () => {
    expect(fileKind([image, file("anim.gif", "gif")])).toBe("images");
    expect(fileKind([file("clip.mov", null, "mov")])).toBe("videos");
    expect(fileKind([pdf, file("b.PDF")])).toBe("pdfs");
    expect(fileKind([file("envoi.zip")])).toBe("archives");
    expect(fileKind([file("lettre.docx")])).toBe("others");
    expect(fileKind([image, pdf])).toBe("others");
  });

  it("ouvre le convertisseur pour une image, la roue Actions pour un document", () => {
    expect(firstModeFor([image], DEFAULT_FILE_WHEELS, ALL_MODES)).toBe("image");
    expect(firstModeFor([file("clip.mp4", null, "mp4")], DEFAULT_FILE_WHEELS, ALL_MODES)).toBe(
      "video",
    );
    expect(firstModeFor([file("lettre.docx")], DEFAULT_FILE_WHEELS, ALL_MODES)).toBe("actions");
    expect(firstModeFor([], DEFAULT_FILE_WHEELS, ALL_MODES)).toBeNull();
  });

  it("suit le réglage du type, sauf vers une roue désactivée", () => {
    const wheels = { ...DEFAULT_FILE_WHEELS, images: { first: "actions" as const, parts: [] } };
    expect(firstModeFor([image], wheels, ALL_MODES)).toBe("actions");
    expect(firstModeFor([image], wheels, ["apps", "image"])).toBeNull();
    const usual = { ...DEFAULT_FILE_WHEELS, pdfs: { first: "usual" as const, parts: [] } };
    expect(firstModeFor([pdf], usual, ALL_MODES)).toBeNull();
  });

  it("propose la compression en ZIP pour deux documents", () => {
    const tree = fileTree(config, [file("a.docx"), file("b.pages")]);
    expect(ids(tree)).toEqual(["files-zip", "files-rename", "files-path"]);
  });

  it("ne propose la fusion qu'à partir de deux PDF", () => {
    expect(ids(fileTree(config, [pdf]))).not.toContain("files-merge");
    expect(ids(fileTree(config, [pdf, file("annexe.pdf")]))[0]).toBe("files-merge");
  });

  it("ne copie qu'une image à la fois", () => {
    expect(ids(fileTree(config, [image]))).toContain("image-copy");
    expect(ids(fileTree(config, [image, file("b.png", "png")]))).not.toContain("image-copy");
  });

  it("décompresse une archive", () => {
    expect(ids(fileTree(config, [file("envoi.zip")]))[0]).toBe("archive-extract");
  });

  it("tient sur une roue pour chaque type", () => {
    for (const nodes of Object.values(FILE_ACTIONS)) {
      expect(nodes.length).toBeLessThanOrEqual(MAX_SECTORS + 1);
      walk(nodes, (item) =>
        expect(item.run ?? item.convert ?? item.children ?? item.setup).toBeDefined(),
      );
    }
    const many = fileTree(
      { ...config, custom: [{ name: "Dev", actions: [{ name: "Build", kind: "command" }], extensions: [] }] },
      [image],
    );
    expect(many.length).toBeLessThanOrEqual(MAX_SECTORS);
  });

  it("suit l'ordre réglé pour le type", () => {
    const tree = fileTree(
      {
        ...config,
        fileWheels: {
          ...DEFAULT_FILE_WHEELS,
          others: {
            first: "actions",
            parts: [
              { id: "files-rename", enabled: true },
              { id: "files-zip", enabled: false },
            ],
          },
        },
      },
      [file("a.docx")],
    );
    expect(ids(tree)).toEqual(["files-rename", "files-path"]);
  });

  it("ne montre que les roues personnalisées faites pour ces fichiers", () => {
    const custom = [
      { name: "Docs", actions: [{ name: "Imprimer", kind: "command" as const }], extensions: ["pdf"] },
      { name: "Tous", actions: [{ name: "Copier", kind: "command" as const }], extensions: [] },
    ];
    const forPdf = node("action-custom", fileTree({ ...config, custom }, [pdf]));
    expect(forPdf.children?.map((item) => item.label)).toEqual(["Docs", "Tous"]);
    const forDoc = node("action-custom", fileTree({ ...config, custom }, [file("a.docx")]));
    // Une seule roue convient : ses actions directement, avec son index d'origine
    expect(forDoc.children?.map((item) => item.label)).toEqual(["Copier"]);
    expect(forDoc.children?.[0].run).toEqual({ kind: "custom", wheel: 1, action: 0 });
  });

  it("n'invite pas à créer une roue personnalisée sur la roue d'un fichier", () => {
    expect(ids(fileTree(config, [pdf]))).not.toContain("action-custom");
  });

  it("revient à la roue Actions habituelle si rien ne convient", () => {
    const empty = {
      ...config,
      fileWheels: {
        ...DEFAULT_FILE_WHEELS,
        archives: {
          first: "actions" as const,
          parts: FILE_ACTIONS.archives.map((item) => ({ id: item.id, enabled: false })),
        },
      },
    };
    expect(ids(fileTree(empty, [file("envoi.zip")]))).toEqual(ids(tree));
  });

  it("reprend la couleur choisie pour la part d'origine", () => {
    const colored = colorizeActions(fileTree(config, [image]), { "action-image": "#123456" });
    expect(node("image-half", colored).color).toBe("#123456");
    expect(node("files-zip", colored).color).toBe("#f97316");
  });
});
