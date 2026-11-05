import { describe, expect, it } from "vitest";
import type { FileInfo } from "../ipc";
import { appItems, formatsFor, shareItems } from "./formats";
import { CENTER, polar } from "./geometry";
import {
  disabledFormats,
  hubFor,
  hubText,
  nextMode,
  preferredMode,
  usableSector,
} from "./selection";

const file = (
  name: string,
  format: FileInfo["format"],
  video: FileInfo["video"] = null,
): FileInfo => ({ path: `/images/${name}`, name, format, video });

const photo = file("photo.png", "png");
const clip = file("clip.mov", null, "mov");
const animation = file("chat.gif", "gif");
const images = formatsFor("image");
const videos = formatsFor("video");
const apps = appItems([
  { path: "/Applications/Signal.app", name: "Signal", icon: null },
  null,
  null,
  null,
  null,
  null,
]);
const share = shareItems([
  { kind: "service", id: "com.apple.share.AirDrop.send", name: "AirDrop", icon: null },
  { kind: "folder", path: "/Drive", name: "Google Drive", icon: null },
  { kind: "app", path: "/Applications/Signal.app", name: "Signal", icon: null },
  null,
  null,
  null,
]);

describe("disabledFormats", () => {
  it("grise le format d'origine", () => {
    expect([...disabledFormats([photo], "image")]).toEqual(["png"]);
    expect([...disabledFormats([clip], "video")]).toEqual(["mov"]);
  });

  it("ne grise rien pour un format absent de la roue", () => {
    expect(disabledFormats([file("a.bmp", "bmp")], "image").size).toBe(0);
    expect(disabledFormats([file("a.avi", null, "avi")], "video").size).toBe(0);
  });

  it("ne grise rien pour des formats différents", () => {
    expect(disabledFormats([photo, file("b.jpg", "jpeg")], "image").size).toBe(0);
  });

  it("grise tout si rien n'est convertible dans ce mode", () => {
    expect(disabledFormats([file("notes.txt", null)], "image").size).toBe(6);
    expect(disabledFormats([photo], "video").size).toBe(6);
    expect(disabledFormats([clip], "image").size).toBe(6);
  });

  it("un GIF animé se convertit aussi en vidéo, sauf vers le GIF", () => {
    expect([...disabledFormats([animation], "video")]).toEqual(["gif"]);
  });
});

describe("preferredMode", () => {
  it("suit la nature des fichiers", () => {
    expect(preferredMode([clip])).toBe("video");
    expect(preferredMode([photo])).toBe("image");
  });

  it("ne tranche pas pour un mélange, un GIF ou rien", () => {
    expect(preferredMode([photo, clip])).toBeNull();
    expect(preferredMode([animation])).toBeNull();
    expect(preferredMode([])).toBeNull();
  });
});

describe("usableSector", () => {
  it("refuse la part du format grisé", () => {
    const [x, y] = polar(120, 0);
    expect(usableSector(x, y, new Set(), images)).toBe(0);
    expect(usableSector(x, y, new Set(["png"]), images)).toBeNull();
    expect(usableSector(x, y, new Set(["png"]), videos)).toBe(0);
  });
});

describe("hubText", () => {
  it("affiche le nom d'un fichier seul", () => {
    expect(hubText([photo], "image")?.label).toBe("photo.png");
  });

  it("compte plusieurs fichiers", () => {
    const text = hubText([photo, file("b.png", "png")], "image");
    expect(text?.label).toBe("2 fichiers");
    expect(text?.title).toBe("photo.png\nb.png");
  });

  it("signale un fichier qui ne convient pas au mode", () => {
    expect(hubText([file("notes.txt", null)], "image")?.hint).toBe("Format non pris en charge");
    expect(hubText([photo], "video")?.hint).toBe("Ce n'est pas une vidéo");
  });
});

describe("hubFor", () => {
  const disabled = disabledFormats([photo], "image");

  it("annonce l'action de la part survolée", () => {
    expect(hubFor(polar(120, 60), disabled, [photo], true, "image", images, null)).toEqual({
      label: "Convertir en JPEG",
      tone: "action",
    });
    expect(hubFor(polar(120, 300), new Set(), [clip], false, "video", videos, null)?.label).toBe(
      "Extraire le son en MP3",
    );
  });

  it("explique pourquoi le format d'origine est grisé", () => {
    expect(hubFor(polar(120, 0), disabled, [photo], true, "image", images, null)?.label).toBe(
      "Déjà en PNG",
    );
  });

  it("le centre annule pendant un glisser, sinon il annonce la roue suivante", () => {
    const center: [number, number] = [CENTER, CENTER];
    expect(hubFor(center, disabled, [photo], true, "image", images, "video")?.label).toBe(
      "Relâcher ici pour annuler",
    );
    expect(hubFor(center, disabled, [photo], false, "image", images, "video")?.label).toBe(
      "Passer en vidéo",
    );
    expect(hubFor(center, new Set(), [], false, "video", videos, "apps")?.label).toBe(
      "Passer aux apps",
    );
    // Une seule roue active : le centre ne propose rien
    expect(hubFor(center, new Set(), [], false, "apps", apps, null)).toBeNull();
  });

  it("revient au nom du fichier hors des parts", () => {
    expect(hubFor(null, disabled, [photo], true, "image", images, null)?.label).toBe("photo.png");
  });

  it("la roue des apps ouvre, ouvre avec, ou propose d'ajouter", () => {
    const top = polar(120, 0);
    expect(hubFor(top, new Set(), [], false, "apps", apps, null)?.label).toBe("Ouvrir Signal");
    expect(hubFor(top, new Set(), [photo], true, "apps", apps, null)?.label).toBe(
      "Ouvrir avec Signal",
    );
    expect(hubFor(polar(120, 60), new Set(), [], false, "apps", apps, null)?.label).toBe(
      "Ajouter une app",
    );
  });
});

describe("nextMode", () => {
  it("suit l'ordre des réglages et revient au début", () => {
    expect(nextMode(["apps", "image", "video"], "apps")).toBe("image");
    expect(nextMode(["apps", "image", "video"], "video")).toBe("apps");
  });

  it("ne change rien avec une seule roue", () => {
    expect(nextMode(["apps"], "apps")).toBeNull();
  });
});

describe("disabledFormats sur les roues des apps et de partage", () => {
  it("ne grise jamais rien", () => {
    expect(disabledFormats([file("notes.txt", null)], "apps").size).toBe(0);
    expect(disabledFormats([file("notes.txt", null)], "share").size).toBe(0);
  });
});

describe("roue de partage", () => {
  it("annonce ce que fait chaque destination", () => {
    const at = (angle: number) =>
      hubFor(polar(120, angle), new Set(), [photo], true, "share", share, null)?.label;
    expect(at(0)).toBe("Envoyer par AirDrop");
    expect(at(60)).toBe("Copier dans Google Drive");
    expect(at(120)).toBe("Copier pour Signal");
    expect(at(180)).toBe("Ajouter un partage");
  });

  it("garde le nom du fichier, quel qu'il soit, hors des parts", () => {
    expect(hubFor(null, new Set(), [file("notes.txt", null)], false, "share", share, null)).toEqual({
      label: "notes.txt",
      tone: "file",
      title: "notes.txt",
      hint: undefined,
    });
  });

  it("pendant un glisser, le centre propose de rester pour basculer", () => {
    const center: [number, number] = [CENTER, CENTER];
    expect(hubFor(center, new Set(), [photo], true, "image", images, "video", "share")).toEqual({
      label: "Restez pour partager",
      tone: "action",
      hint: "Relâchez pour annuler",
    });
    expect(hubFor(center, new Set(), [photo], true, "share", share, null, "image")?.label).toBe(
      "Restez pour convertir",
    );
    expect(hubFor(center, new Set(), [photo], true, "share", share, null)?.label).toBe(
      "Relâcher ici pour annuler",
    );
  });

  it("le centre y mène depuis la roue précédente", () => {
    const center: [number, number] = [CENTER, CENTER];
    expect(hubFor(center, new Set(), [], false, "apps", apps, "share")?.label).toBe(
      "Passer au partage",
    );
  });
});

describe("appItems", () => {
  const app = (name: string) => ({ path: `/Applications/${name}.app`, name, icon: null });

  it("garde six parts au moins, et une par emplacement au-delà", () => {
    expect(appItems([app("Signal")])).toHaveLength(6);
    expect(appItems(Array.from({ length: 9 }, (_, i) => app(`App ${i}`)))).toHaveLength(9);
    expect(appItems(Array.from({ length: 14 }, (_, i) => app(`App ${i}`)))).toHaveLength(10);
  });

  it("pose la pastille de chaque app, et rien sur une part vide", () => {
    const items = appItems([app("Signal"), null, app("Mail")], ["3", "1", null]);
    expect(items[0].badge).toBe("3");
    expect(items[1].empty).toBe(true);
    expect(items[1].badge).toBeUndefined();
    expect(items[2].badge).toBeUndefined();
  });

  it("annonce le menu de partage du système", () => {
    const [item] = shareItems([{ kind: "system", name: "Partager…", icon: null }]);
    expect(item.action).toBe("Partager avec…");
    expect(item.icon).toMatch(/^data:image\/svg\+xml,/);
  });
});
