import { describe, expect, it } from "vitest";
import {
  clampPercent,
  emptySyncProgress,
  syncOpLabel,
  syncProgressCounts,
  syncProgressCurrent,
  syncProgressDetail,
  syncProgressTitle,
} from "./syncProgress";

describe("syncProgressTitle", () => {
  it("names running upload and download", () => {
    expect(syncProgressTitle("upload", "running")).toBe("正在上传");
    expect(syncProgressTitle("download", "running")).toBe("正在下载");
  });

  it("names finished and failed states", () => {
    expect(syncProgressTitle("upload", "done")).toBe("上传完成");
    expect(syncProgressTitle("download", "done")).toBe("下载完成");
    expect(syncProgressTitle("upload", "error")).toBe("同步失败");
  });
});

describe("syncOpLabel", () => {
  it("maps unison ops", () => {
    expect(syncOpLabel("add")).toBe("增加");
    expect(syncOpLabel("modify")).toBe("修改");
    expect(syncOpLabel("delete")).toBe("删除");
    expect(syncOpLabel("")).toBe("");
  });
});

describe("syncProgressCounts", () => {
  it("lists add modify delete", () => {
    expect(syncProgressCounts({ added: 2, modified: 1, deleted: 4 })).toBe(
      "增加 2 个，修改 1 个，删除 4 个",
    );
  });
});

describe("syncProgressDetail", () => {
  it("shows current op, file, speed and counts", () => {
    expect(
      syncProgressDetail({
        ...emptySyncProgress("p1"),
        file: "src/a.ts",
        op: "modify",
        speed: "1.2MB/s",
        transferred: 4,
        added: 3,
        modified: 1,
        deleted: 1,
      }),
    ).toBe("修改 src/a.ts · 1.2MB/s · 增加 3 个，修改 1 个，删除 1 个");
  });

  it("uses error message", () => {
    expect(
      syncProgressDetail({
        ...emptySyncProgress("p1"),
        phase: "error",
        message: "未找到 unison，请安装 Unison 并加入 PATH",
      }),
    ).toBe("未找到 unison，请安装 Unison 并加入 PATH");
  });
});

describe("syncProgressCurrent", () => {
  it("prefixes the current file with its op", () => {
    expect(
      syncProgressCurrent({
        ...emptySyncProgress("p1"),
        file: "old.txt",
        op: "delete",
      }),
    ).toBe("删除 old.txt");
  });
});

describe("clampPercent", () => {
  it("keeps values in 0-100", () => {
    expect(clampPercent(45.2)).toBe(45);
    expect(clampPercent(-4)).toBe(0);
    expect(clampPercent(140)).toBe(100);
  });
});
