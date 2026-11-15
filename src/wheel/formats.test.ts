import { describe, expect, it } from "vitest";
import { OUTPUT_FORMATS, hasVariants, variantItems } from "./formats";

describe("variantes d'un format", () => {
  it("proposent qualité et taille aux formats avec perte, la taille seule au PNG", () => {
    const [png, , webp] = OUTPUT_FORMATS;
    expect(variantItems(webp).map((item) => item.id)).toEqual([
      "webp:best",
      "webp:light",
      "webp:fullHd",
      "webp:half",
    ]);
    expect(variantItems(png).map((item) => item.id)).toEqual(["png:fullHd", "png:half"]);
  });

  it("n'existent pas pour le SVG ni l'ICO", () => {
    expect(hasVariants("svg")).toBe(false);
    expect(hasVariants("ico")).toBe(false);
    expect(hasVariants("jpeg")).toBe(true);
  });

  it("gardent la couleur de leur format", () => {
    const webp = { ...OUTPUT_FORMATS[2], color: "#123456", ink: "#ffffff" };
    expect(variantItems(webp).every((item) => item.color === "#123456")).toBe(true);
  });
});
