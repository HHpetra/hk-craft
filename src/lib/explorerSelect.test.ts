import { describe, expect, it } from "vitest";
import {
  applyClear,
  applyClick,
  applyContextSelect,
  applySelectAll,
  emptySelection,
  type ExplorerSelection,
} from "./explorerSelect";

const vis = ["a", "b", "c", "d", "e"];

function paths(state: ExplorerSelection) {
  return [...state.selected];
}

describe("explorerSelect", () => {
  it("plain click selects only that item and sets the anchor", () => {
    const next = applyClick(emptySelection(), vis, "c");
    expect(paths(next)).toEqual(["c"]);
    expect(next.anchor).toBe("c");
  });

  it("plain click replaces an existing selection", () => {
    const prev = applyClick(emptySelection(), vis, "a");
    const next = applyClick(prev, vis, "d");
    expect(paths(next)).toEqual(["d"]);
    expect(next.anchor).toBe("d");
  });

  it("ctrl click toggles membership and moves the anchor", () => {
    const one = applyClick(emptySelection(), vis, "a");
    const two = applyClick(one, vis, "c", { ctrl: true });
    expect(paths(two).sort()).toEqual(["a", "c"]);
    expect(two.anchor).toBe("c");
    const off = applyClick(two, vis, "a", { ctrl: true });
    expect(paths(off)).toEqual(["c"]);
    expect(off.anchor).toBe("a");
  });

  it("shift click selects the closed range from the anchor", () => {
    const start = applyClick(emptySelection(), vis, "b");
    const next = applyClick(start, vis, "d", { shift: true });
    expect(paths(next)).toEqual(["b", "c", "d"]);
    expect(next.anchor).toBe("b");
  });

  it("shift click without an anchor selects only that item", () => {
    const next = applyClick(emptySelection(), vis, "d", { shift: true });
    expect(paths(next)).toEqual(["d"]);
    expect(next.anchor).toBe("d");
  });

  it("shift range uses the current visible order, not a previous list", () => {
    const start = applyClick(emptySelection(), vis, "b");
    const filtered = ["b", "d", "e"];
    const next = applyClick(start, filtered, "e", { shift: true });
    expect(paths(next)).toEqual(["b", "d", "e"]);
    expect(next.anchor).toBe("b");
  });

  it("ctrl+a selects every visible path", () => {
    const next = applySelectAll(vis);
    expect(paths(next)).toEqual(vis);
    expect(next.anchor).toBe("a");
  });

  it("ctrl+a on an empty list clears selection", () => {
    const next = applySelectAll([]);
    expect(paths(next)).toEqual([]);
    expect(next.anchor).toBeNull();
  });

  it("right-click keeps a multi-selection when the target is already selected", () => {
    const start = applyClick(applyClick(emptySelection(), vis, "a"), vis, "c", { ctrl: true });
    const next = applyContextSelect(start, "a");
    expect(paths(next).sort()).toEqual(["a", "c"]);
    expect(next.anchor).toBe("c");
  });

  it("right-click on an unselected item selects only that item", () => {
    const start = applyClick(applyClick(emptySelection(), vis, "a"), vis, "c", { ctrl: true });
    const next = applyContextSelect(start, "d");
    expect(paths(next)).toEqual(["d"]);
    expect(next.anchor).toBe("d");
  });

  it("clear empties the set and the anchor", () => {
    const next = applyClear();
    expect(paths(next)).toEqual([]);
    expect(next.anchor).toBeNull();
  });
});
