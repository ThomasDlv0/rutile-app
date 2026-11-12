import { describe, expect, it } from "vitest";
import { parseExtensions, siteName, webAddress } from "./web";

describe("webAddress", () => {
  it("complète une adresse tapée sans https", () => {
    expect(webAddress("youtube.com")).toBe("https://youtube.com/");
    expect(webAddress("  http://exemple.fr/page ")).toBe("http://exemple.fr/page");
  });

  it("refuse ce qui n'est pas une adresse web", () => {
    expect(webAddress("")).toBeNull();
    expect(webAddress("youtube")).toBeNull();
    expect(webAddress("mon site.fr")).toBeNull();
    expect(webAddress("javascript:alert(1)")).toBeNull();
  });
});

describe("siteName", () => {
  it("retire le www", () => {
    expect(siteName("https://www.youtube.com/")).toBe("youtube.com");
    expect(siteName("https://fr.wikipedia.org/wiki/Rutile")).toBe("fr.wikipedia.org");
  });
});

describe("parseExtensions", () => {
  it("nettoie une liste tapée à la main", () => {
    expect(parseExtensions(".PDF, docx; txt  pdf")).toEqual(["pdf", "docx", "txt"]);
    expect(parseExtensions("a b, c/d")).toEqual(["a", "b"]);
  });
});
