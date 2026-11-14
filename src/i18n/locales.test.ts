import { describe, expect, it } from "vitest";
import { LANGUAGES } from ".";

// Chaque langue doit traduire chaque texte français, avec les mêmes valeurs à remplacer
const files = import.meta.glob<Record<string, string>>("./locales/*/*.json", {
  eager: true,
  import: "default",
});

const PLURAL = /\.(zero|one|two|few|many|other)$/;

function byFile(language: string): Map<string, Record<string, string>> {
  const found = new Map<string, Record<string, string>>();
  for (const [path, dictionary] of Object.entries(files)) {
    const match = path.match(/locales\/([^/]+)\/([^/]+)\.json$/);
    if (match && match[1] === language) found.set(match[2], dictionary);
  }
  return found;
}

/** Clés d'un fichier, celles d'un texte accordé au nombre ramenées à leur nom. */
function keys(dictionary: Record<string, string>): Set<string> {
  return new Set(Object.keys(dictionary).map((key) => key.replace(PLURAL, ".#")));
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => name).sort();

const source = byFile("fr");

describe("fichiers de langue", () => {
  it("chaque langue a les mêmes fichiers que le français", () => {
    for (const { code } of LANGUAGES) {
      expect([...byFile(code).keys()].sort(), code).toEqual([...source.keys()].sort());
    }
  });

  for (const { code } of LANGUAGES.filter(({ code }) => code !== "fr")) {
    it(`${code} traduit chaque texte, sans en inventer`, () => {
      for (const [file, french] of source) {
        const translated = byFile(code).get(file) ?? {};
        const missing = [...keys(french)].filter((key) => !keys(translated).has(key));
        const extra = [...keys(translated)].filter((key) => !keys(french).has(key));
        expect({ file, missing, extra }, code).toEqual({ file, missing: [], extra: [] });
      }
    });

    it(`${code} garde les valeurs à remplacer et ne laisse rien de vide`, () => {
      for (const [file, french] of source) {
        const translated = byFile(code).get(file) ?? {};
        for (const [key, text] of Object.entries(translated)) {
          expect(text.trim(), `${code}/${file} ${key}`).not.toBe("");
          const base = key.replace(PLURAL, "");
          const original =
            french[key] ?? french[`${base}.other`] ?? french[`${base}.one`] ?? "";
          // Un texte au singulier peut écrire « une » plutôt que {count}
          const expected = placeholders(original).filter(
            (name) => !(PLURAL.test(key) && name === "count"),
          );
          const actual = placeholders(text).filter(
            (name) => !(PLURAL.test(key) && name === "count"),
          );
          expect(actual, `${code}/${file} ${key}`).toEqual(expected);
        }
      }
    });
  }

  it("un texte accordé au nombre a toujours sa forme « other »", () => {
    for (const { code } of LANGUAGES) {
      for (const [file, dictionary] of byFile(code)) {
        const bases = new Set(
          Object.keys(dictionary)
            .filter((key) => PLURAL.test(key))
            .map((key) => key.replace(PLURAL, "")),
        );
        for (const base of bases) {
          expect(dictionary[`${base}.other`], `${code}/${file} ${base}.other`).toBeDefined();
        }
      }
    }
  });
});
