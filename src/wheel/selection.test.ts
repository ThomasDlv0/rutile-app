import { describe, expect, it } from "vitest";
import type { FileInfo } from "../ipc";
import { CENTER, polar } from "./geometry";
import { disabledFormats, hubFor, hubText, preferredMode, usableSector } from "./selection";

const file = (
  name: string,
  format: FileInfo["format"],
  video: FileInfo["video"] = null,
): FileInfo => ({ path: `/images/${name}`, name, format, video });

const photo = file("photo.png", "png");
const clip = file("clip.mov", null, "mov");
const animation = file("chat.gif", "gif");

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
    expect(usableSector(x, y, new Set(), "image")).toBe(0);
    expect(usableSector(x, y, new Set(["png"]), "image")).toBeNull();
    expect(usableSector(x, y, new Set(["png"]), "video")).toBe(0);
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
    expect(hubFor(polar(120, 60), disabled, [photo], true, "image")).toEqual({
      label: "Convertir en JPEG",
      tone: "action",
    });
    expect(hubFor(polar(120, 300), new Set(), [clip], false, "video")?.label).toBe(
      "Extraire le son en MP3",
    );
  });

  it("explique pourquoi le format d'origine est grisé", () => {
    expect(hubFor(polar(120, 0), disabled, [photo], true, "image")?.label).toBe("Déjà en PNG");
  });

  it("le centre annule pendant un glisser, sinon il change de mode", () => {
    const center: [number, number] = [CENTER, CENTER];
    expect(hubFor(center, disabled, [photo], true, "image")?.label).toBe(
      "Relâcher ici pour annuler",
    );
    expect(hubFor(center, disabled, [photo], false, "image")?.label).toBe("Passer en vidéo");
    expect(hubFor(center, new Set(), [], false, "video")?.label).toBe("Passer en images");
  });

  it("revient au nom du fichier hors des parts", () => {
    expect(hubFor(null, disabled, [photo], true, "image")?.label).toBe("photo.png");
  });
});
