import { describe, expect, it } from "vitest";
import {
  CENTER,
  DISK_RADIUS,
  HUB_RADIUS,
  buttonCenter,
  polar,
  sectorAt,
  sectorPath,
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

describe("roue à une seule part", () => {
  it("occupe tout le disque, sans séparation", () => {
    for (const angle of [0, 90, 180, 270]) {
      const [x, y] = polar(120, angle);
      expect(sectorAt(x, y, 1)).toBe(0);
    }
    expect(separatorAngles(1)).toEqual([]);
    expect(buttonCenter(0, 1)).toEqual(polar(123, 0));
  });

  it("se trace en couronne entière, sans arc qui revient sur lui-même", () => {
    const path = sectorPath(0, 1);
    // Deux contours fermés (l'extérieur et le trou du centre), de deux demi-cercles chacun
    expect(path.match(/M /g)).toHaveLength(2);
    expect(path.match(/A /g)).toHaveLength(4);
    expect(path).not.toContain("NaN");
    // Une part parmi d'autres reste un secteur
    expect(sectorPath(0, 6).match(/A /g)).toHaveLength(2);
  });
});
