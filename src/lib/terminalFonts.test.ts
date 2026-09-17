import { describe, expect, it } from "vitest";
import { terminalFontFamily } from "./terminalFonts";

describe("terminalFontFamily", () => {
  it("falls back to monospace CJK, not proportional YaHei", () => {
    const families = terminalFontFamily("")
      .split(",")
      .map((part) => part.trim());
    expect(families).toContain('"Microsoft YaHei Mono"');
    expect(families).toContain('"Sarasa Term SC"');
    expect(families).toContain('"Noto Sans Mono CJK SC"');
    expect(families).toContain("monospace");
    expect(families).not.toContain('"Microsoft YaHei"');
    expect(families).not.toContain("Microsoft YaHei");
  });
});
