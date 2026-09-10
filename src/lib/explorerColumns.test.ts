import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORER_COLUMNS,
  MIN_EXPLORER_COLUMN,
  MIN_EXPLORER_COLUMN_PX,
  minColumnPct,
  normalizeColumnWidths,
  resizeAdjacent,
} from "./explorerColumns";

function sum(widths: readonly number[]): number {
  return widths.reduce((total, value) => total + value, 0);
}

describe("normalizeColumnWidths", () => {
  it("returns the default when input is missing", () => {
    expect(normalizeColumnWidths()).toEqual([...DEFAULT_EXPLORER_COLUMNS]);
    expect(normalizeColumnWidths(null)).toEqual([...DEFAULT_EXPLORER_COLUMNS]);
    expect(normalizeColumnWidths([])).toEqual([...DEFAULT_EXPLORER_COLUMNS]);
  });

  it("returns the default when length is not 4", () => {
    expect(normalizeColumnWidths([40, 30, 30])).toEqual([...DEFAULT_EXPLORER_COLUMNS]);
    expect(normalizeColumnWidths([20, 20, 20, 20, 20])).toEqual([...DEFAULT_EXPLORER_COLUMNS]);
  });

  it("returns the default for non-finite or non-positive values", () => {
    expect(normalizeColumnWidths([40, 30, NaN, 30])).toEqual([...DEFAULT_EXPLORER_COLUMNS]);
    expect(normalizeColumnWidths([40, 30, Infinity, 30])).toEqual([...DEFAULT_EXPLORER_COLUMNS]);
    expect(normalizeColumnWidths([40, 30, 0, 30])).toEqual([...DEFAULT_EXPLORER_COLUMNS]);
    expect(normalizeColumnWidths([40, 30, -5, 35])).toEqual([...DEFAULT_EXPLORER_COLUMNS]);
  });

  it("scales valid widths so they sum to 100", () => {
    const widths = normalizeColumnWidths([50, 50, 50, 50]);
    expect(widths).toEqual([25, 25, 25, 25]);
    expect(sum(widths)).toBeCloseTo(100);
  });

  it("clamps columns below the minimum before scaling", () => {
    const widths = normalizeColumnWidths([80, 1, 1, 18]);
    expect(widths.every((value) => value >= MIN_EXPLORER_COLUMN - 1e-9)).toBe(true);
    expect(sum(widths)).toBeCloseTo(100);
  });
});

describe("resizeAdjacent", () => {
  it("moves width between neighboring columns", () => {
    const next = resizeAdjacent([40, 30, 16, 14], 0, 10);
    expect(next[0]).toBeCloseTo(50);
    expect(next[1]).toBeCloseTo(20);
    expect(next[2]).toBeCloseTo(16);
    expect(next[3]).toBeCloseTo(14);
    expect(sum(next)).toBeCloseTo(100);
  });

  it("does not shrink a column below the minimum", () => {
    const next = resizeAdjacent([42, 28, 16, 14], 0, 100);
    expect(next[1]).toBeCloseTo(MIN_EXPLORER_COLUMN);
    expect(next[0]).toBeCloseTo(42 + 28 - MIN_EXPLORER_COLUMN);
    expect(sum(next)).toBeCloseTo(100);
  });

  it("does not grow a column by shrinking its neighbor below the minimum", () => {
    const next = resizeAdjacent([42, 28, 16, 14], 0, -100);
    expect(next[0]).toBeCloseTo(MIN_EXPLORER_COLUMN);
    expect(next[1]).toBeCloseTo(28 + 42 - MIN_EXPLORER_COLUMN);
    expect(sum(next)).toBeCloseTo(100);
  });

  it("ignores an out-of-range divider index", () => {
    expect(resizeAdjacent([42, 28, 16, 14], -1, 5)).toEqual([42, 28, 16, 14]);
    expect(resizeAdjacent([42, 28, 16, 14], 3, 5)).toEqual([42, 28, 16, 14]);
  });

  it("does not resize when the pair cannot fit two minimums", () => {
    const start = [8, 8, 50, 34];
    expect(resizeAdjacent(start, 0, 20, 20)).toEqual(normalizeColumnWidths(start));
  });
});

describe("minColumnPct", () => {
  it("uses the percentage floor on a wide table", () => {
    expect(minColumnPct(2000)).toBe(MIN_EXPLORER_COLUMN);
  });

  it("raises the floor so a column stays at least the pixel minimum", () => {
    expect(minColumnPct(400)).toBeCloseTo((MIN_EXPLORER_COLUMN_PX / 400) * 100);
  });

  it("never exceeds an even four-column split", () => {
    expect(minColumnPct(100)).toBe(25);
  });
});
