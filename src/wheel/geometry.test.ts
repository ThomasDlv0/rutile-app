import { describe, expect, it } from "vitest";
import {
  CENTER,
  DISK_RADIUS,
  HUB_RADIUS,
  buttonCenter,
  polar,
  sectorAt,
  separatorAngles,
} from "./geometry";
import { shortenMiddle } from "./fileName";

describe("sectorAt", () => {
  it("trouve la part sous chaque bouton", () => {
    for (let index = 0; index < 6; index++) {
      const [x, y] = polar(120, index * 60);
      expect(sectorAt(x, y)).toBe(index);
    }
  });

  it("change de part de chaque côté d'une séparation", () => {
    const [x1, y1] = polar(120, 29);
    const [x2, y2] = polar(120, 31);
    expect(sectorAt(x1, y1)).toBe(0);
    expect(sectorAt(x2, y2)).toBe(1);
  });

  it("revient à la première part juste avant le haut", () => {
    const [x, y] = polar(120, 355);
    expect(sectorAt(x, y)).toBe(0);
  });

  it("suit le nombre de parts d'une roue d'apps ou de partage", () => {
    for (const count of [8, 10]) {
      for (let index = 0; index < count; index++) {
        const [x, y] = buttonCenter(index, count);
        expect(sectorAt(x, y, count)).toBe(index);
      }
      expect(separatorAngles(count)).toHaveLength(count);
    }
    const [x, y] = polar(120, 40);
    expect(sectorAt(x, y, 6)).toBe(1);
    expect(sectorAt(x, y, 10)).toBe(1);
    expect(sectorAt(x, y, 8)).toBe(1);
  });

  it("ignore le cercle central et l'extérieur du disque", () => {
    expect(sectorAt(CENTER, CENTER)).toBeNull();
    expect(sectorAt(CENTER, CENTER - HUB_RADIUS + 1)).toBeNull();
    expect(sectorAt(CENTER, CENTER - DISK_RADIUS - 1)).toBeNull();
    expect(sectorAt(0, 0)).toBeNull();
  });
});

describe("shortenMiddle", () => {
  it("garde les noms courts intacts", () => {
    expect(shortenMiddle("photo.png", 22)).toBe("photo.png");
  });

  it("coupe au milieu en gardant l'extension", () => {
    const short = shortenMiddle("vacances-ete-2026-plage-coucher.jpeg", 22);
    expect(short).toHaveLength(22);
    expect(short.endsWith(".jpeg")).toBe(true);
    expect(short).toContain("…");
  });
});
