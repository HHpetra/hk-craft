import { describe, expect, it } from "vitest";
import { fileName, isValidFileName, joinDir, parentDir, uniqueName } from "./fsNames";

describe("fsNames", () => {
  it("rejects empty, dotted, and reserved file names", () => {
    expect(isValidFileName("foo.ts")).toBe(true);
    expect(isValidFileName("新建文件夹")).toBe(true);
    expect(isValidFileName("")).toBe(false);
    expect(isValidFileName("  a  ")).toBe(false);
    expect(isValidFileName(".")).toBe(false);
    expect(isValidFileName("..")).toBe(false);
    expect(isValidFileName("a/b")).toBe(false);
    expect(isValidFileName("a\\b")).toBe(false);
    expect(isValidFileName("a:b")).toBe(false);
    expect(isValidFileName("foo.")).toBe(false);
  });

  it("numbers copies before the extension, and whole names for folders", () => {
    expect(uniqueName("bar.ts", ["foo.ts"])).toBe("bar.ts");
    expect(uniqueName("foo.ts", ["foo.ts", "foo (1).ts"])).toBe("foo (2).ts");
    expect(uniqueName("src", ["src"], true)).toBe("src (1)");
    expect(uniqueName("foo.bar", ["foo.bar"], true)).toBe("foo.bar (1)");
  });

  it("joins and splits windows-style paths", () => {
    expect(joinDir("C:\\proj", "a.ts")).toBe("C:\\proj\\a.ts");
    expect(parentDir("C:\\proj\\src\\a.ts")).toBe("C:\\proj\\src");
    expect(parentDir("C:\\proj")).toBe("C:\\");
    expect(fileName("C:\\proj\\src\\a.ts")).toBe("a.ts");
  });
});
