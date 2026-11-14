import { describe, expect, it } from "vitest";
import published from "../../docs/release-notes/v1.4.0.md?raw";
import { parseInline, parseNotes } from "./notes";

describe("notes de version", () => {
  it("lit les notes publiées : paragraphe, titres et listes à plusieurs lignes", () => {
    const blocks = parseNotes(published);
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      inlines: expect.arrayContaining([{ text: "Rutile 1.4.0", strong: true }]),
    });
    expect(blocks[1]).toEqual({ kind: "heading", inlines: [{ text: "Nouveautés" }] });
    const list = blocks[2];
    if (list.kind !== "list") throw new Error("une liste était attendue");
    expect(list.items).toHaveLength(6);
    expect(list.items[0][0]).toEqual({ text: "Vos propres roues", strong: true });
    // Les lignes suivantes d'un point le prolongent
    const first = list.items[0].map(({ text }) => text).join("");
    expect(first).toContain("jusqu'à dix parts : une application");
    expect(blocks).toContainEqual({ kind: "heading", inlines: [{ text: "À savoir" }] });
  });

  it("garde un texte simple en un seul paragraphe", () => {
    expect(parseNotes("  Roues perso.\nEt logos.  ")).toEqual([
      { kind: "paragraph", inlines: [{ text: "Roues perso. Et logos." }] },
    ]);
    expect(parseNotes("\n \n")).toEqual([]);
  });

  it("ne coupe pas une liste sur une ligne vide", () => {
    expect(parseNotes("- un\n\n- deux")).toEqual([
      { kind: "list", items: [[{ text: "un" }], [{ text: "deux" }]] },
    ]);
  });

  it("reconnaît le gras, le code et le texte des liens", () => {
    expect(parseInline("Le **gras**, `pdf` et [la page](https://exemple.fr).")).toEqual([
      { text: "Le " },
      { text: "gras", strong: true },
      { text: ", " },
      { text: "pdf", code: true },
      { text: " et la page." },
    ]);
  });

  it("n'interprète pas de HTML", () => {
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([
      { text: "<img src=x onerror=alert(1)>" },
    ]);
  });
});
