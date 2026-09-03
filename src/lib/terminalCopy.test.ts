import { describe, expect, it } from "vitest";
import { shouldCopySelection, type KeyChord } from "./terminalCopy";

function chord(partial: Partial<KeyChord> = {}): KeyChord {
  return {
    type: "keydown",
    code: "KeyC",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...partial,
  };
}

describe("shouldCopySelection", () => {
  it("copies Ctrl+C only when the terminal has a selection", () => {
    const key = chord({ ctrlKey: true });
    expect(shouldCopySelection(key, true)).toBe(true);
    expect(shouldCopySelection(key, false)).toBe(false);
  });

  it("always copies Ctrl+Shift+C and Ctrl+Insert", () => {
    expect(shouldCopySelection(chord({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(shouldCopySelection(chord({ code: "Insert", ctrlKey: true }), false)).toBe(true);
  });

  it("does not treat Ctrl+V or Alt+C as copy", () => {
    expect(shouldCopySelection(chord({ code: "KeyV", ctrlKey: true }), true)).toBe(false);
    expect(shouldCopySelection(chord({ ctrlKey: true, altKey: true }), true)).toBe(false);
  });
});
