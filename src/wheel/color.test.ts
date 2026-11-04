import { describe, expect, it } from "vitest";
import { DARK_INK, LIGHT_INK, contrast, glow, isHexColor, readableInk } from "./color";

describe("readableInk", () => {
  it("garde le texte blanc sur les couleurs soutenues", () => {
    for (const color of ["#3b82f6", "#f97316", "#16a34a", "#8b5cf6", "#6b7280", "#ec4899"]) {
      expect(readableInk(color)).toBe(LIGHT_INK);
    }
  });

  it("passe au texte foncé sur une couleur claire", () => {
    expect(readableInk("#f2b705")).toBe(DARK_INK);
    expect(readableInk("#ffffff")).toBe(DARK_INK);
    expect(readableInk("#a3e635")).toBe(DARK_INK);
  });
});

describe("contrast", () => {
  it("vaut 21 entre le noir et le blanc", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21);
  });
});

describe("glow", () => {
  it("rend la couleur à demi transparente", () => {
    expect(glow("#2f7cf6")).toBe("rgba(47, 124, 246, 0.55)");
  });
});

describe("isHexColor", () => {
  it("n'accepte que #rrggbb", () => {
    expect(isHexColor("#2F7CF6")).toBe(true);
    expect(isHexColor("#fff")).toBe(false);
    expect(isHexColor("bleu")).toBe(false);
  });
});
