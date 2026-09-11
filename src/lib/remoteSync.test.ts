import { describe, expect, it } from "vitest";
import { remoteSyncConfigured, syncConfirmCopy, syncDoneNotice } from "./remoteSync";

describe("remoteSyncConfigured", () => {
  it("requires all three fields", () => {
    expect(remoteSyncConfigured({ remote_host: "10.0.0.2", remote_user: "dev", remote_path: "/tmp/p" })).toBe(
      true,
    );
    expect(remoteSyncConfigured({ remote_host: "10.0.0.2", remote_user: "dev" })).toBe(false);
    expect(remoteSyncConfigured({ remote_host: " ", remote_user: "dev", remote_path: "/tmp/p" })).toBe(false);
  });
});

describe("syncConfirmCopy", () => {
  it("warns less for git upload", () => {
    expect(syncConfirmCopy("upload", true)).toEqual({
      title: "上传到远程",
      message: "将把本地项目镜像到远程电脑。远程上多出的文件会被删除；.gitignore 中的文件不会上传。",
      danger: false,
    });
  });

  it("marks no-git upload as danger", () => {
    const copy = syncConfirmCopy("upload", false);
    expect(copy.danger).toBe(true);
    expect(copy.message).toContain("不会按 .gitignore 排除");
  });

  it("marks git download as danger", () => {
    const copy = syncConfirmCopy("download", true);
    expect(copy.danger).toBe(true);
    expect(copy.message).toContain(".gitignore 内的除外");
  });

  it("marks no-git download as danger and full copy", () => {
    const copy = syncConfirmCopy("download", false);
    expect(copy.danger).toBe(true);
    expect(copy.message).toContain("不会按 .gitignore 排除");
    expect(copy.message).toContain("本地多出的文件会被删除");
  });
});

describe("syncDoneNotice", () => {
  it("breaks down added, modified and deleted", () => {
    expect(
      syncDoneNotice("upload", { files: 12, added: 9, modified: 3, deleted: 3, used_git: true }),
    ).toBe("已上传：增加 9 个，修改 3 个，删除 3 个");
    expect(
      syncDoneNotice("download", { files: 4, added: 4, modified: 0, deleted: 0, used_git: false }),
    ).toBe("已下载：增加 4 个，修改 0 个，删除 0 个");
  });
});
