import { describe, expect, it } from "vitest";
import type { FileInfo } from "../ipc";
import { CENTER, polar } from "./geometry";
import { disabledFormats, hubFor, hubText, usableSector } from "./selection";

const file = (name: string, format: FileInfo["format"]): FileInfo => ({
  path: `/images/${name}`,
  name,
  format,
});

describe("disabledFormats", () => {
  it("grise le format d'origine", () => {
    expect([...disabledFormats([file("a.png", "png")])]).toEqual(["png"]);
  });

  it("ne grise rien pour un format absent de la roue", () => {
    expect(disabledFormats([file("a.gif", "gif")]).size).toBe(0);
  });

  it("ne grise rien pour des formats différents", () => {
    expect(disabledFormats([file("a.png", "png"), file("b.jpg", "jpeg")]).size).toBe(0);
  });

  it("grise tout si aucun fichier n'est une image lisible", () => {
    expect(disabledFormats([file("notes.txt", null)]).size).toBe(6);
  });
});

describe("usableSector", () => {
  it("refuse la part du format grisé", () => {
    const [x, y] = polar(120, 0);
    expect(usableSector(x, y, new Set())).toBe(0);
    expect(usableSector(x, y, new Set(["png"]))).toBeNull();
  });
});

describe("hubText", () => {
  it("affiche le nom d'un fichier seul", () => {
    expect(hubText([file("photo.png", "png")])?.label).toBe("photo.png");
  });

  it("compte plusieurs fichiers", () => {
    const text = hubText([file("a.png", "png"), file("b.png", "png")]);
    expect(text?.label).toBe("2 fichiers");
    expect(text?.title).toBe("a.png\nb.png");
  });

  it("signale un fichier non pris en charge", () => {
    expect(hubText([file("notes.txt", null)])?.hint).toBe("Format non pris en charge");
  });
});

describe("hubFor", () => {
  const photo = [file("photo.png", "png")];
  const disabled = disabledFormats(photo);

  it("annonce l'action de la part survolée", () => {
    expect(hubFor(polar(120, 60), disabled, photo, true)).toEqual({
      label: "Convertir en JPEG",
      tone: "action",
    });
  });

  it("explique pourquoi le format d'origine est grisé", () => {
    expect(hubFor(polar(120, 0), disabled, photo, true)?.label).toBe("Déjà en PNG");
  });

  it("indique qu'un dépôt au centre annule", () => {
    expect(hubFor([CENTER, CENTER], disabled, photo, true)?.label).toBe(
      "Relâcher ici pour annuler",
    );
  });

  it("revient au nom du fichier hors des parts", () => {
    expect(hubFor(null, disabled, photo, true)?.label).toBe("photo.png");
    expect(hubFor([CENTER, CENTER], disabled, photo, false)?.label).toBe("photo.png");
  });
});
