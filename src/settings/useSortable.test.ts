import { describe, expect, it } from "vitest";
import { dropIndex, moved } from "./useSortable";

describe("moved", () => {
  it("déplace un élément vers le bas ou vers le haut", () => {
    expect(moved(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moved(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(moved(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});

describe("dropIndex", () => {
  // Quatre lignes de 40 px, l'une sous l'autre
  const rows = [0, 40, 80, 120].map((top) => ({ top, bottom: top + 40 }));

  it("reste en place tant que la ligne n'a pas passé le milieu de sa voisine", () => {
    expect(dropIndex(rows, 1, 0)).toBe(1);
    expect(dropIndex(rows, 1, 19)).toBe(1);
    expect(dropIndex(rows, 1, -19)).toBe(1);
  });

  it("prend la place de la ligne dont elle dépasse le milieu", () => {
    expect(dropIndex(rows, 1, 21)).toBe(2);
    expect(dropIndex(rows, 1, 61)).toBe(3);
    expect(dropIndex(rows, 1, -21)).toBe(0);
    expect(dropIndex(rows, 3, -200)).toBe(0);
  });
});
