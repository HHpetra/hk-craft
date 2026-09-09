import { describe, expect, it } from "vitest";
import { deleteConfirmCopy } from "./explorerDelete";

describe("deleteConfirmCopy", () => {
  it("names a single file", () => {
    expect(deleteConfirmCopy([{ name: "a.ts", is_dir: false }])).toEqual({
      title: "确认删除",
      message: "确定删除文件「a.ts」吗？此操作无法撤销。",
    });
  });

  it("names a single folder", () => {
    expect(deleteConfirmCopy([{ name: "src", is_dir: true }])).toEqual({
      title: "确认删除",
      message: "确定删除文件夹「src」吗？此操作无法撤销。",
    });
  });

  it("counts multiple items", () => {
    expect(
      deleteConfirmCopy([
        { name: "a.ts", is_dir: false },
        { name: "src", is_dir: true },
      ]),
    ).toEqual({
      title: "确认删除",
      message: "确定删除这 2 项吗？此操作无法撤销。",
    });
  });
});
