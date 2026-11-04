/** Touches qui ne font que modifier les autres : on attend la touche principale. */
const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
  "CapsLock",
  "Fn",
]);

export type KeyPress = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

export type Recorded =
  /** Seules des touches de modification sont enfoncées : la saisie continue. */
  | { kind: "waiting" }
  /** Une touche seule serait captée partout : il faut au moins un modificateur. */
  | { kind: "needsModifier" }
  | { kind: "shortcut"; accelerator: string };

/**
 * Raccourci au format attendu par Rust (`Super+Shift+Space`), à partir d'une touche pressée.
 * Les noms de touches du navigateur (`KeyA`, `Digit5`, `Space`, `F5`) sont repris tels quels.
 */
export function recordShortcut(press: KeyPress): Recorded {
  if (MODIFIER_CODES.has(press.code)) return { kind: "waiting" };
  const modifiers = [
    press.metaKey && "Super",
    press.ctrlKey && "Control",
    press.altKey && "Alt",
    press.shiftKey && "Shift",
  ].filter((part): part is string => Boolean(part));
  const functionKey = /^F([1-9]|1\d|2[0-4])$/.test(press.code);
  if (modifiers.length === 0 && !functionKey) return { kind: "needsModifier" };
  return { kind: "shortcut", accelerator: [...modifiers, press.code].join("+") };
}
