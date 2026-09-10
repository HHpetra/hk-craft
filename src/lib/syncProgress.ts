import type { SyncDirection, SyncProgress } from "../types";

export function emptySyncProgress(projectId: string): SyncProgress {
  return {
    project_id: projectId,
    percent: 0,
    speed: "",
    file: "",
    transferred: 0,
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

export function syncProgressDetail(progress: SyncProgress): string {
  if (progress.phase === "error") {
    return progress.message || "同步失败";
  }
  const parts: string[] = [];
  if (progress.file) parts.push(progress.file);
  if (progress.speed) parts.push(progress.speed);
  const counts = `已传输 ${progress.transferred} 个`;
  const extra = progress.deleted > 0 ? `，删除 ${progress.deleted} 个` : "";
  parts.push(`${counts}${extra}`);
  return parts.join(" · ");
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
