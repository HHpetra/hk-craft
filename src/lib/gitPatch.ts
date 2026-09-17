import type { GitPatchPreview, GitPatchResult } from "../types";

export function emptyGitPatchPreview(): GitPatchPreview {
  return {
    added: [],
    modified: [],
    deleted: [],
    added_count: 0,
    modified_count: 0,
    deleted_count: 0,
    local_dirty: false,
    local_head: "",
    remote_head: "",
  };
}

export function gitPatchHasChanges(preview: GitPatchPreview): boolean {
  return preview.added_count + preview.modified_count + preview.deleted_count > 0;
}

export function gitHeadMismatchMessage(): string {
  return "本地与远程不在同一提交，请先切换到同一分支后再拉取改动。";
}

export function gitPatchConfirmCopy(preview: GitPatchPreview): {
  title: string;
  message: string;
  danger: boolean;
  empty: boolean;
} {
  const title = "拉取改动";
  const empty = !gitPatchHasChanges(preview);
  if (empty) {
    return { title, message: "远程没有未提交改动。", danger: false, empty: true };
  }
  const danger = preview.modified_count > 0 || preview.deleted_count > 0;
  const lines = [
    `将增加 ${preview.added_count} 个，覆盖 ${preview.modified_count} 个，删除 ${preview.deleted_count} 个。`,
  ];
  if (preview.local_dirty) {
    lines.push("本地工作区已有未提交改动，应用后会叠在一起。");
  }
  if (danger) {
    lines.push("本地被覆盖或删除的文件无法撤销。");
  }
  return { title, message: lines.join("\n"), danger, empty: false };
}

export function gitPatchDoneNotice(result: GitPatchResult): string {
  return `已拉取改动：增加 ${result.added} 个，修改 ${result.modified} 个，删除 ${result.deleted} 个`;
}
