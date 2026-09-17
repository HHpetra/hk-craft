import { describe, expect, it } from "vitest";
import { hardwareCaret, isolatedInverseCaret, type InverseCell } from "./imeCaret";

function cell(inverse: boolean, width = 1): InverseCell {
  return { inverse, width };
}

function line(spec: string, widths?: number[]): InverseCell[] {
  return [...spec].map((ch, i) => cell(ch === "#", widths?.[i] ?? 1));
}

describe("isolatedInverseCaret", () => {
  it("pins to a single inverse cell", () => {
    expect(
      isolatedInverseCaret({
        lines: [line("....#....")],
        cursorCol: 0,
        cursorRow: 0,
      }),
    ).toEqual({ col: 4, row: 0 });
  });

  it("accepts a two-cell fullwidth caret and pins the head", () => {
    expect(
      isolatedInverseCaret({
        lines: [line("..##....", [2, 0, 1, 1, 1, 1, 1, 1])],
        cursorCol: 2,
        cursorRow: 0,
      }),
    ).toEqual({ col: 2, row: 0 });
  });

  it("pins a spacer-first run to the previous column", () => {
    expect(
      isolatedInverseCaret({
        lines: [line(".#......", [1, 0, 1, 1, 1, 1, 1, 1])],
        cursorCol: 1,
        cursorRow: 0,
      }),
    ).toEqual({ col: 0, row: 0 });
  });

  it("ignores long inverse runs such as a status bar", () => {
    expect(
      isolatedInverseCaret({
        lines: [line("........"), line("########")],
        cursorCol: 3,
        cursorRow: 0,
      }),
    ).toBeNull();
  });

  it("picks the isolated run closest to the hardware cursor", () => {
    expect(
      isolatedInverseCaret({
        lines: [line("#......."), line("....#..."), line("........")],
        cursorCol: 4,
        cursorRow: 1,
      }),
    ).toEqual({ col: 4, row: 1 });
  });
});

describe("hardwareCaret", () => {
  it("clamps to the visible grid", () => {
    expect(hardwareCaret(-1, -4, 80, 24)).toEqual({ col: 0, row: 0 });
    expect(hardwareCaret(99, 40, 80, 24)).toEqual({ col: 79, row: 23 });
  });
});
