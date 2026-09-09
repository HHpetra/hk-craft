import { describe, expect, it } from "vitest";
import {
  clientToCell,
  clampCell,
  hostMouseUpAction,
  isDragGesture,
  sgrClick,
  sgrMouse,
  wheelButton,
} from "./sgrMouse";

describe("clampCell", () => {
  it("stays inside 1-based cols/rows", () => {
    expect(clampCell(0, 0, 80, 24)).toEqual({ col: 1, row: 1 });
    expect(clampCell(81, 25, 80, 24)).toEqual({ col: 80, row: 24 });
    expect(clampCell(10.9, 3.2, 80, 24)).toEqual({ col: 10, row: 3 });
  });
});

describe("clientToCell", () => {
  const rect = { left: 10, top: 20, width: 80, height: 24 };

  it("maps the origin to 1,1 and the far corner to cols,rows", () => {
    expect(clientToCell(10, 20, rect, 80, 24)).toEqual({ col: 1, row: 1 });
    expect(clientToCell(89.9, 43.9, rect, 80, 24)).toEqual({ col: 80, row: 24 });
  });

  it("clamps points outside the screen", () => {
    expect(clientToCell(0, 0, rect, 80, 24)).toEqual({ col: 1, row: 1 });
    expect(clientToCell(200, 200, rect, 80, 24)).toEqual({ col: 80, row: 24 });
  });

  it("returns null for a degenerate screen", () => {
    expect(clientToCell(10, 20, { ...rect, width: 0 }, 80, 24)).toBeNull();
    expect(clientToCell(10, 20, rect, 0, 24)).toBeNull();
  });
});

describe("isDragGesture", () => {
  it("treats sub-threshold jitter as a click", () => {
    expect(isDragGesture({ startX: 10, startY: 10, endX: 12, endY: 11 })).toBe(false);
  });

  it("treats pixel travel past the threshold as a drag", () => {
    expect(isDragGesture({ startX: 10, startY: 10, endX: 16, endY: 10 })).toBe(true);
  });

  it("treats a cell change as a drag even when pixels are small", () => {
    expect(
      isDragGesture({
        startX: 10,
        startY: 10,
        endX: 12,
        endY: 10,
        startCell: { col: 4, row: 2 },
        endCell: { col: 5, row: 2 },
      }),
    ).toBe(true);
  });
});

describe("hostMouseUpAction", () => {
  it("sends a left short-press to the TUI", () => {
    expect(hostMouseUpAction({ button: 0, dragged: false, shiftKey: false, hasSelection: false })).toBe(
      "click",
    );
  });

  it("copies a drag or Shift selection instead of clicking", () => {
    expect(hostMouseUpAction({ button: 0, dragged: true, shiftKey: false, hasSelection: true })).toBe("copy");
    expect(hostMouseUpAction({ button: 0, dragged: false, shiftKey: true, hasSelection: true })).toBe("copy");
  });

  it("does not click after a drag that produced no text", () => {
    expect(hostMouseUpAction({ button: 0, dragged: true, shiftKey: false, hasSelection: false })).toBe("none");
  });

  it("ignores right and middle buttons", () => {
    expect(hostMouseUpAction({ button: 2, dragged: false, shiftKey: false, hasSelection: true })).toBe("none");
    expect(hostMouseUpAction({ button: 1, dragged: false, shiftKey: false, hasSelection: false })).toBe("none");
  });
});

describe("sgr sequences", () => {
  it("encodes SGR 1006 press, release, and a left click pair", () => {
    expect(sgrMouse(0, 4, 8)).toBe("\x1b[<0;4;8M");
    expect(sgrMouse(64, 4, 8, false)).toBe("\x1b[<64;4;8M");
    expect(sgrMouse(0, 4, 8, true)).toBe("\x1b[<0;4;8m");
    expect(sgrClick(4, 8)).toBe("\x1b[<0;4;8M\x1b[<0;4;8m");
  });

  it("picks the dominant wheel axis", () => {
    expect(wheelButton(0, -40)).toBe(64);
    expect(wheelButton(0, 40)).toBe(65);
    expect(wheelButton(-20, 0)).toBe(66);
    expect(wheelButton(20, 2)).toBe(67);
    expect(wheelButton(0, 0)).toBeNull();
  });
});
