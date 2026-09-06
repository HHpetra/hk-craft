import { describe, expect, it } from "vitest";
import { createMouseStripper, emptyMouseStripState, stripMouseTracking } from "./stripMouseTracking";

describe("stripMouseTracking", () => {
  it("drops a lone mouse DECSET", () => {
    const state = emptyMouseStripState();
    expect(stripMouseTracking("\x1b[?1000h", state)).toBe("");
    expect(stripMouseTracking("\x1b[?1002hhello", state)).toBe("hello");
    expect(stripMouseTracking("\x1b[?9h", state)).toBe("");
    expect(stripMouseTracking("\x1b[?1006h", state)).toBe("");
  });

  it("keeps cursor-visible and other private modes", () => {
    const state = emptyMouseStripState();
    expect(stripMouseTracking("\x1b[?25h", state)).toBe("\x1b[?25h");
    expect(stripMouseTracking("\x1b[?1049h", state)).toBe("\x1b[?1049h");
  });

  it("removes only mouse numbers from a combined list", () => {
    const state = emptyMouseStripState();
    expect(stripMouseTracking("\x1b[?1000;25h", state)).toBe("\x1b[?25h");
    expect(stripMouseTracking("\x1b[?1000;1006h", state)).toBe("");
    expect(stripMouseTracking("\x1b[?25;1002;1049h", state)).toBe("\x1b[?25;1049h");
  });

  it("holds an incomplete CSI across chunks", () => {
    const strip = createMouseStripper();
    expect(strip("pre\x1b[?10")).toBe("pre");
    expect(strip("00hpost")).toBe("post");
    expect(strip("\x1b[?25")).toBe("");
    expect(strip("h")).toBe("\x1b[?25h");
  });
});
