import { describe, expect, it } from "vitest";
import type { CustomPartView, CustomWheelView, FileInfo, PartKind } from "../ipc";
import {
  type ActionNode,
  DEFAULT_FILE_WHEELS,
  FILE_ACTIONS,
  actionCatalog,
  actionChoices,
  actionParent,
  actionTree,
  actionsAt,
  arrange,
  colorizeActions,
  customTree,
  disabledActions,
  fileKind,
  fileTree,
  filesFor,
  firstModeFor,
  opensOnDwell,
  wheelModes,
} from "./actions";
import { ALL_MODES, type Mode, WEB_ICON } from "./formats";
import { MAX_SECTORS } from "./geometry";

const file = (name: string, format: FileInfo["format"] = null, video: FileInfo["video"] = null) => ({
  path: `/tmp/${name}`,
  name,
  format,
  video,
});
const tree = actionTree({ windowLayout: true });
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
      expect(item.run ?? item.convert ?? item.children ?? item.goesTo).toBeDefined(),
    );
  });

  it("retire les fenêtres quand le système ne sait pas les ranger", () => {
    const wayland = actionTree({ windowLayout: false });
    expect(wayland.some((item) => item.id === "action-windows")).toBe(false);
  });

  it("garde un clic direct sur Capture, et des options en restant dessus", () => {
    const capture = node("action-capture");
    expect(capture.run).toEqual({ kind: "capture", target: "zone", delay: 0 });
    expect(opensOnDwell(capture)).toBe(true);
    expect(opensOnDwell(node("action-text"))).toBe(false);
  });

  it("laisse les roues personnalisées à leur place, parmi les roues", () => {
    expect(tree.some((item) => item.id === "action-custom")).toBe(false);
  });
});

const part = (
  kind: PartKind,
  value: string | null = null,
  name = "",
  icon: string | null = null,
): CustomPartView => ({ name, kind, value, icon });
const wheel = (parts: CustomPartView[], extensions: string[] = [], id = "mix"): CustomWheelView => ({
  id,
  name: "Mix",
  parts,
  extensions,
});

describe("roue personnalisée", () => {
  const mixed = customTree(
    {
      windowLayout: true,
      custom: [
        wheel([
          part("app", null, "Mail", "data:mail"),
          part("folder", null, "Projets"),
          part("url", null, "YouTube"),
          part("convert", "png"),
          part("convert", "mp3"),
          part("action", "action-capture"),
          part("action", "capture-zone"),
          part("action", "image-fullHd"),
          part("shortcut", null, "Ranger"),
          part("command", null, "Build"),
        ]),
      ],
    },
    0,
  );

  it("mélange apps, sites, conversions et actions sur une même roue", () => {
    expect(mixed.map((item) => item.label)).toEqual([
      "Mail",
      "Projets",
      "YouTube",
      "PNG",
      "MP3",
      "Capture",
      "Zone",
      "1920",
      "Ranger",
      "Build",
    ]);
    const ids = mixed.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of mixed) {
      expect(
        item.run ?? item.convert ?? item.convertImage ?? item.children,
        item.label,
      ).toBeDefined();
    }
  });

  it("ouvre une app avec les fichiers de la roue, un dossier ou un site sans eux", () => {
    const [mail, folder, site] = mixed;
    const image = file("photo.png", "png");
    expect(mail).toMatchObject({
      icon: "data:mail",
      opens: true,
      action: "Ouvrir Mail",
      dragAction: "Ouvrir avec Mail",
      run: { kind: "custom", wheel: 0, action: 0 },
    });
    expect(filesFor(mail, [image])).toEqual([image]);
    expect(filesFor(folder, [image])).toEqual([]);
    // Sans icône lisible, un dossier garde une pastille, un site son globe
    expect(folder.glyph).toBe("files");
    expect(site.icon).toBe(WEB_ICON);
  });

  it("reprend les conversions et les actions des roues de Rutile", () => {
    const [, , , png, mp3, capture, zone, fullHd] = mixed;
    expect(png).toMatchObject({ convertImage: "png", needs: "images", family: "png" });
    expect(mp3).toMatchObject({ convert: "mp3", needs: "videos", action: "Extraire le son en MP3" });
    // La part entière garde sa sous-roue, une action seule se lance au clic
    expect(capture.children).toHaveLength(4);
    expect(opensOnDwell(capture)).toBe(true);
    expect(zone.run).toEqual({ kind: "capture", target: "zone", delay: 0 });
    expect(zone.children).toBeUndefined();
    expect(fullHd.run).toEqual({ kind: "retouch", retouch: "fullHd" });
  });

  it("prend la couleur réglée pour le format ou pour la part d'origine", () => {
    const colored = colorizeActions(mixed, { png: "#111111", "action-capture": "#222222" });
    const [, , , png, mp3, capture, zone, fullHd] = colored;
    expect(png.color).toBe("#111111");
    expect(mp3.color).toBe("#f97316");
    expect(capture.color).toBe("#222222");
    expect(zone.color).toBe("#222222");
    expect(fullHd.color).toBe("#8b5cf6");
  });

  it("garde l'index d'origine d'une part quand une part inconnue la précède", () => {
    const nodes = customTree(
      {
        windowLayout: true,
        custom: [
          wheel([]),
          wheel([part("convert", "exe"), part("action", "disparue"), part("command", null, "Build")]),
        ],
      },
      1,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].run).toEqual({ kind: "custom", wheel: 1, action: 2 });
    expect(nodes[0].hides).toBe(false);
  });

  it("retire une action que le système ne sait pas faire", () => {
    const custom = [wheel([part("action", "windows-left")])];
    expect(customTree({ windowLayout: true, custom }, 0)).toHaveLength(1);
    expect(customTree({ windowLayout: false, custom }, 0)).toHaveLength(0);
    expect(customTree({ windowLayout: true, custom }, 7)).toEqual([]);
  });

  it("grise une conversion sans fichier qui convienne, ou déjà dans ce format", () => {
    const [mail, , , png, mp3] = mixed;
    const nodes = [mail, png, mp3];
    expect([...disabledActions(nodes, [file("clip.mov", null, "mov")])]).toEqual([png.id]);
    expect([...disabledActions(nodes, [file("photo.jpg", "jpeg")])]).toEqual([mp3.id]);
    expect([...disabledActions(nodes, [file("photo.png", "png")])]).toEqual([png.id, mp3.id]);
    expect(disabledActions(nodes, []).size).toBe(0);
  });

  it("propose chaque action une seule fois, à la couleur de sa part", () => {
    const choices = actionChoices({ windowLayout: true });
    const all = choices.flatMap((choice) => choice.actions);
    const ids = all.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(choices.map((choice) => choice.group.id)).not.toContain("action-apps");
    for (const item of all) expect(item.color, item.id).toBeDefined();
    // Les actions que la roue Actions ne propose que pour un fichier y sont aussi
    expect(ids).toEqual(expect.arrayContaining(["files-path", "pdf-text", "image-copy"]));
    const files = choices.find((choice) => choice.group.id === "action-files")!;
    expect(files.actions[0].id).toBe("action-files");
    expect(files.actions.map((item) => item.id)).toContain("rename-date");
  });
});

describe("roues affichées", () => {
  const filled = [part("convert", "png")];
  const config = {
    windowLayout: true,
    modes: ["apps", "custom:pdf", "image", "custom:vide", "custom:tous", "custom:disparue"] as Mode[],
    custom: [wheel(filled, ["pdf"], "pdf"), wheel([], [], "vide"), wheel(filled, [], "tous")],
  };

  it("ne garde une roue réservée à des extensions que pour ces fichiers", () => {
    expect(wheelModes(config, [file("contrat.pdf")])).toEqual([
      "apps",
      "custom:pdf",
      "image",
      "custom:tous",
    ]);
    expect(wheelModes(config, [file("lettre.docx")])).toEqual(["apps", "image", "custom:tous"]);
    expect(wheelModes(config, [file("a.pdf"), file("b.docx")])).toEqual([
      "apps",
      "image",
      "custom:tous",
    ]);
  });

  it("les montre toutes sans fichier, sauf une roue vide ou disparue", () => {
    expect(wheelModes(config, [])).toEqual(["apps", "custom:pdf", "image", "custom:tous"]);
  });

  it("peut ouvrir d'abord une roue personnalisée restée seule", () => {
    const alone = { ...config, modes: ["custom:tous"] as Mode[] };
    expect(wheelModes(alone, [])).toEqual(["custom:tous"]);
    expect(firstModeFor([file("a.docx")], DEFAULT_FILE_WHEELS, wheelModes(alone, []))).toBeNull();
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

  it("passe tous les fichiers de la roue à une commande personnalisée", () => {
    const [build] = customTree(
      { windowLayout: true, custom: [wheel([part("command", null, "Build")])] },
      0,
    );
    expect(filesFor(build, [image, pdf])).toEqual([image, pdf]);
    expect(filesFor(build, [])).toEqual([]);
  });

  it("accepte un GIF parmi les vidéos", () => {
    const gif = file("anim.gif", "gif");
    expect(filesFor(node("video-gif", node("action-video").children!), [gif])).toEqual([gif]);
  });
});

describe("ordre des parts", () => {
  const catalog = actionCatalog({ windowLayout: true });

  it("suit l'ordre des réglages, et masque les parts éteintes", () => {
    const ordered = actionTree({
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
  const config = { windowLayout: true, fileWheels: DEFAULT_FILE_WHEELS };
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
      expect(nodes.length).toBeLessThanOrEqual(MAX_SECTORS);
      walk(nodes, (item) => expect(item.run ?? item.convert ?? item.children).toBeDefined());
    }
    expect(fileTree(config, [image]).length).toBeLessThanOrEqual(MAX_SECTORS);
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

  it("ne contient plus la part des roues personnalisées", () => {
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
