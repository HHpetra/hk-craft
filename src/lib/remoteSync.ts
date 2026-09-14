import type { SyncDirection, SyncPreview, SyncResult } from "../types";

export const SYNC_CONFIRM_LIST_LIMIT = 30;

export function remoteSyncConfigured(project: {
  remote_host?: string;
  remote_user?: string;
  remote_path?: string;
}): boolean {
  return Boolean(project.remote_host?.trim() && project.remote_user?.trim() && project.remote_path?.trim());
}

export function emptySyncPreview(usedGit = false): SyncPreview {
  return {
    used_git: usedGit,
    added: [],
    modified: [],
    deleted: [],
    added_count: 0,
    modified_count: 0,
    deleted_count: 0,
  };
}

export function previewChangeCount(preview: SyncPreview): number {
  return preview.added_count + preview.modified_count + preview.deleted_count;
}

export function previewHasChanges(preview: SyncPreview): boolean {
  return previewChangeCount(preview) > 0;
}

export function previewIsDangerous(preview: SyncPreview): boolean {
  return preview.modified_count > 0 || preview.deleted_count > 0;
}

export function listedPreviewPaths(paths: string[], total: number, limit = SYNC_CONFIRM_LIST_LIMIT): {
  shown: string[];
  hidden: number;
} {
  const shown = paths.slice(0, limit);
  return { shown, hidden: Math.max(0, total - shown.length) };
}

export function syncConfirmCopy(
  direction: SyncDirection,
  preview: SyncPreview,
): { title: string; message: string; danger: boolean; empty: boolean } {
  const title = direction === "upload" ? "上传到远程" : "从远程下载";
  const target = direction === "upload" ? "远程" : "本地";
  const empty = !previewHasChanges(preview);
  if (empty) {
    return { title, message: "没有需要同步的变更。", danger: false, empty: true };
  }
  const danger = previewIsDangerous(preview);
  const lines = [
    `将增加 ${preview.added_count} 个，覆盖 ${preview.modified_count} 个，删除 ${preview.deleted_count} 个。`,
  ];
  if (danger) {
    lines.push(`${target}上被覆盖或删除的文件无法撤销。`);
  }
  if (preview.used_git) {
    lines.push("已按 .gitignore 排除。");
  } else {
    lines.push("当前项目没有 Git 仓库，不会按 .gitignore 排除。");
  }
  return { title, message: lines.join("\n"), danger, empty: false };
}

export function syncDoneNotice(direction: SyncDirection, result: SyncResult): string {
  const counts = `增加 ${result.added} 个，修改 ${result.modified} 个，删除 ${result.deleted} 个`;
  return direction === "upload" ? `已上传：${counts}` : `已下载：${counts}`;
}
