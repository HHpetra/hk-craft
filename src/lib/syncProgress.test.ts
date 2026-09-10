import { describe, expect, it } from "vitest";
import { clampPercent, emptySyncProgress, syncProgressDetail, syncProgressTitle } from "./syncProgress";

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

describe("syncProgressDetail", () => {
  it("shows file, speed and counts", () => {
    expect(
      syncProgressDetail({
        ...emptySyncProgress("p1"),
        file: "src/a.ts",
        speed: "1.2MB/s",
        transferred: 3,
        deleted: 1,
      }),
    ).toBe("src/a.ts · 1.2MB/s · 已传输 3 个，删除 1 个");
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

describe("clampPercent", () => {
  it("keeps values in 0-100", () => {
    expect(clampPercent(45.2)).toBe(45);
    expect(clampPercent(-4)).toBe(0);
    expect(clampPercent(140)).toBe(100);
  });
});
