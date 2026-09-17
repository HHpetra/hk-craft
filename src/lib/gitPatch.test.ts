import { describe, expect, it } from "vitest";
import {
  emptyGitPatchPreview,
  gitHeadMismatchMessage,
  gitPatchConfirmCopy,
  gitPatchDoneNotice,
  gitPatchHasChanges,
} from "./gitPatch";
import type { GitPatchPreview } from "../types";

function preview(partial: Partial<GitPatchPreview>): GitPatchPreview {
  return { ...emptyGitPatchPreview(), ...partial };
}

describe("gitPatchConfirmCopy", () => {
  it("names an empty remote patch", () => {
    const copy = gitPatchConfirmCopy(emptyGitPatchPreview());
    expect(copy.title).toBe("拉取改动");
    expect(copy.empty).toBe(true);
    expect(copy.danger).toBe(false);
    expect(copy.message).toBe("远程没有未提交改动。");
  });

  it("warns when the patch overwrites or deletes local files", () => {
    const copy = gitPatchConfirmCopy(
      preview({
        added: ["new.ts"],
        added_count: 1,
        modified: ["src/a.ts"],
        modified_count: 1,
        deleted: ["old.md"],
        deleted_count: 1,
      }),
    );
    expect(copy.empty).toBe(false);
    expect(copy.danger).toBe(true);
    expect(copy.message).toContain("增加 1 个，覆盖 1 个，删除 1 个");
    expect(copy.message).toContain("本地被覆盖或删除的文件无法撤销");
    expect(copy.message).not.toContain("叠在一起");
  });

  it("warns when the local working tree is already dirty", () => {
    const copy = gitPatchConfirmCopy(
      preview({ added: ["new.ts"], added_count: 1, local_dirty: true }),
    );
    expect(copy.danger).toBe(false);
    expect(copy.message).toContain("本地工作区已有未提交改动，应用后会叠在一起。");
  });
});

describe("gitPatch helpers", () => {
  it("detects whether a preview has changes", () => {
    expect(gitPatchHasChanges(emptyGitPatchPreview())).toBe(false);
    expect(gitPatchHasChanges(preview({ added_count: 1 }))).toBe(true);
  });

  it("explains a HEAD mismatch", () => {
    expect(gitHeadMismatchMessage()).toBe(
      "本地与远程不在同一提交，请先切换到同一分支后再拉取改动。",
    );
  });

  it("summarizes an applied patch", () => {
    expect(gitPatchDoneNotice({ files: 4, added: 2, modified: 1, deleted: 1 })).toBe(
      "已拉取改动：增加 2 个，修改 1 个，删除 1 个",
    );
  });
});
