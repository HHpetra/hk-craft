import type { SyncDirection, SyncProgress } from "../types";

export function emptySyncProgress(projectId: string): SyncProgress {
  return {
    project_id: projectId,
    percent: 0,
    speed: "",
    file: "",
    op: "",
    transferred: 0,
    added: 0,
    modified: 0,
    deleted: 0,
    phase: "running",
    message: "",
  };
}

export function syncProgressTitle(direction: SyncDirection, phase: string): string {
  if (phase === "error") return "同步失败";
  if (phase === "done") return direction === "upload" ? "上传完成" : "下载完成";
  return direction === "upload" ? "正在上传" : "正在下载";
}

export function syncOpLabel(op: string | undefined): string {
  if (op === "modify") return "修改";
  if (op === "delete") return "删除";
  if (op === "add") return "增加";
  return "";
}

export function syncProgressCounts(progress: {
  added: number;
  modified: number;
  deleted: number;
}): string {
  return `增加 ${progress.added} 个，修改 ${progress.modified} 个，删除 ${progress.deleted} 个`;
}

export function syncProgressCurrent(progress: SyncProgress): string {
  const parts: string[] = [];
  const op = syncOpLabel(progress.op);
  if (progress.file) parts.push(op ? `${op} ${progress.file}` : progress.file);
  if (progress.speed) parts.push(progress.speed);
  return parts.join(" · ");
}

export function syncProgressDetail(progress: SyncProgress): string {
  if (progress.phase === "error") {
    return progress.message || "同步失败";
  }
  const current = syncProgressCurrent(progress);
  const counts = syncProgressCounts(progress);
  return current ? `${current} · ${counts}` : counts;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
