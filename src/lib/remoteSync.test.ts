import { describe, expect, it } from "vitest";
import {
  emptySyncPreview,
  listedPreviewPaths,
  previewHasChanges,
  previewIsDangerous,
  remoteSyncConfigured,
  SYNC_CONFIRM_LIST_LIMIT,
  syncConfirmCopy,
  syncDoneNotice,
} from "./remoteSync";
import type { SyncPreview } from "../types";

function preview(partial: Partial<SyncPreview>): SyncPreview {
  return { ...emptySyncPreview(partial.used_git ?? false), ...partial };
}

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
  it("marks overwrite or delete as danger for upload", () => {
    const copy = syncConfirmCopy(
      "upload",
      preview({
        used_git: true,
        modified: ["src/a.ts"],
        modified_count: 1,
        deleted: ["old.md"],
        deleted_count: 1,
      }),
    );
    expect(copy.danger).toBe(true);
    expect(copy.empty).toBe(false);
    expect(copy.title).toBe("上传到远程");
    expect(copy.message).toContain("覆盖 1 个，删除 1 个");
    expect(copy.message).toContain("远程上被覆盖或删除的文件无法撤销");
    expect(copy.message).toContain("已按 .gitignore 排除");
  });

  it("is not danger when upload only adds files", () => {
    const copy = syncConfirmCopy(
      "upload",
      preview({ used_git: true, added: ["src/new.ts"], added_count: 1 }),
    );
    expect(copy.danger).toBe(false);
    expect(copy.empty).toBe(false);
    expect(copy.message).toContain("增加 1 个");
    expect(copy.message).not.toContain("无法撤销");
  });

  it("marks empty preview as close-only", () => {
    const copy = syncConfirmCopy("upload", emptySyncPreview(true));
    expect(copy.empty).toBe(true);
    expect(copy.danger).toBe(false);
    expect(copy.message).toBe("没有需要同步的变更。");
  });

  it("warns local files for download", () => {
    const copy = syncConfirmCopy(
      "download",
      preview({
        used_git: false,
        deleted: ["local-only.ts"],
        deleted_count: 1,
      }),
    );
    expect(copy.title).toBe("从远程下载");
    expect(copy.danger).toBe(true);
    expect(copy.message).toContain("本地上被覆盖或删除的文件无法撤销");
    expect(copy.message).toContain("不会按 .gitignore 排除");
  });
});

describe("preview helpers", () => {
  it("detects changes and danger", () => {
    expect(previewHasChanges(emptySyncPreview())).toBe(false);
    expect(previewIsDangerous(preview({ added_count: 2 }))).toBe(false);
    expect(previewIsDangerous(preview({ modified_count: 1 }))).toBe(true);
    expect(previewIsDangerous(preview({ deleted_count: 1 }))).toBe(true);
  });

  it("caps listed paths and reports hidden count", () => {
    const paths = Array.from({ length: 35 }, (_, i) => `f${i}.ts`);
    const listed = listedPreviewPaths(paths, 40);
    expect(listed.shown).toHaveLength(SYNC_CONFIRM_LIST_LIMIT);
    expect(listed.hidden).toBe(10);
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
