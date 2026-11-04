import { describe, expect, it } from "vitest";
import { type KeyPress, recordShortcut } from "./accelerator";

const press = (code: string, modifiers: Partial<KeyPress> = {}): KeyPress => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("recordShortcut", () => {
  it("compose les modificateurs et la touche", () => {
    expect(recordShortcut(press("Space", { metaKey: true, shiftKey: true }))).toEqual({
      kind: "shortcut",
      accelerator: "Super+Shift+Space",
    });
    expect(recordShortcut(press("KeyR", { ctrlKey: true, altKey: true }))).toEqual({
      kind: "shortcut",
      accelerator: "Control+Alt+KeyR",
    });
  });

  it("attend la touche principale tant que seuls des modificateurs sont pressés", () => {
    expect(recordShortcut(press("ShiftLeft", { shiftKey: true }))).toEqual({ kind: "waiting" });
  });

  it("refuse une lettre seule mais accepte une touche de fonction", () => {
    expect(recordShortcut(press("KeyA"))).toEqual({ kind: "needsModifier" });
    expect(recordShortcut(press("F13"))).toEqual({ kind: "shortcut", accelerator: "F13" });
  });
});
