import { useSyncExternalStore } from "react";
import common from "./locales/fr/common.json";
import settings from "./locales/fr/settings.json";
import update from "./locales/fr/update.json";
import wheel from "./locales/fr/wheel.json";

/** Langues de Rutile : code et nom dans la langue elle-même, dans l'ordre du menu des
 * réglages. Les mêmes que dans `crates/i18n`. */
export const LANGUAGES = [
  { code: "fr", name: "Français" },
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
  { code: "de", name: "Deutsch" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português (Brasil)" },
  { code: "zh", name: "简体中文" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "ru", name: "Русский" },
] as const;

export type Language = (typeof LANGUAGES)[number]["code"];

/** Langue d'origine des textes : celle qui sert quand une traduction manque. */
const SOURCE: Language = "fr";

/** Textes de l'interface en français : leurs clés sont celles que `t` accepte. */
type Messages = typeof common & typeof settings & typeof wheel & typeof update;
type AnyKey = keyof Messages & string;
/** Un texte qui s'accorde au nombre a des clés « nom.one », « nom.other »… ; on l'appelle par
 * « nom » avec `tn`. */
type PluralForm = "zero" | "one" | "two" | "few" | "many" | "other";
export type PluralKey = AnyKey extends infer K
  ? K extends `${infer Base}.other`
    ? Base
    : never
  : never;
export type MessageKey = Exclude<AnyKey, `${string}.${PluralForm}`>;

type Dictionary = Record<string, string>;

// Les fichiers de toutes les langues, réunis par langue (sauf `app.json`, propre à Rust)
const files = import.meta.glob<Dictionary>("./locales/*/*.json", {
  eager: true,
  import: "default",
});
const dictionaries: Record<string, Dictionary> = {};
for (const [path, dictionary] of Object.entries(files)) {
  const [, language, file] = path.match(/locales\/([^/]+)\/([^/]+)\.json$/) ?? [];
  if (!language || file === "app") continue;
  dictionaries[language] = { ...dictionaries[language], ...dictionary };
}

/** Code d'une langue de Rutile d'après une étiquette de langue (« fr-FR », « zh-Hans »),
 * `null` si Rutile ne la connaît pas. */
export function supported(tag: string | null | undefined): Language | null {
  const primary = tag?.split(/[-_.@]/)[0]?.trim().toLowerCase();
  return LANGUAGES.find(({ code }) => code === primary)?.code ?? null;
}

/** Nom d'une langue dans la langue elle-même. */
export function languageName(code: string): string {
  return LANGUAGES.find((language) => language.code === code)?.name ?? code;
}

let current: Language = SOURCE;
const listeners = new Set<() => void>();

/** Change la langue de toute la fenêtre ; une langue inconnue ne change rien. */
export function setLanguage(tag: string) {
  const code = supported(tag);
  if (!code || code === current) return;
  current = code;
  document.documentElement.lang = code;
  for (const listener of listeners) listener();
}

export function language(): Language {
  return current;
}

/** Langue en cours, et nouveau rendu quand elle change. */
export function useLanguage(): Language {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

function lookup(key: string): string | undefined {
  return dictionaries[current]?.[key] ?? dictionaries[SOURCE]?.[key];
}

function fill(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? format(params[name]) : whole,
  );
}

function format(value: string | number): string {
  return typeof value === "number" ? value.toLocaleString(current) : value;
}

/** Texte de `key` dans la langue en cours, ses `{nom}` remplacés par `params`. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  return fill(lookup(key) ?? key, params);
}

/** Texte de `key` accordé au nombre `count`, qui remplace aussi `{count}`. */
export function tn(
  key: PluralKey,
  count: number,
  params?: Record<string, string | number>,
): string {
  const form = new Intl.PluralRules(current).select(count);
  const text = lookup(`${key}.${form}`) ?? lookup(`${key}.other`) ?? key;
  return fill(text, { count, ...params });
}

/** Une liste (« A, B et C ») dans la langue en cours. */
export function list(items: readonly string[]): string {
  return new Intl.ListFormat(current, { style: "long", type: "conjunction" }).format(items);
}
