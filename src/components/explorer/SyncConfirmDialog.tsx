import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  listedPreviewPaths,
  previewHasChanges,
  syncConfirmCopy,
} from "../../lib/remoteSync";
import { gitPatchConfirmCopy, gitPatchHasChanges } from "../../lib/gitPatch";
import type { GitPatchPreview, SyncDirection, SyncPreview } from "../../types";

export function SyncScanDialog({ direction }: { direction: SyncDirection }) {
  const title = direction === "upload" ? "上传到远程" : "从远程下载";
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-scan-title"
    >
      <div className="w-[400px] max-w-[90vw] rounded-xl border border-line bg-surface-elevated p-5 shadow-2xl">
        <h2 id="sync-scan-title" className="mb-3 text-[13px] font-semibold text-ink">
          {title}
        </h2>
        <p className="text-[12px] leading-5 text-ink-muted">正在扫描变更…</p>
      </div>
    </div>,
    document.body,
  );
}

export function SyncConfirmDialog({
  direction,
  preview,
  onConfirm,
  onCancel,
  busy = false,
}: {
  direction: SyncDirection;
  preview: SyncPreview;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const copy = syncConfirmCopy(direction, preview);
  const empty = !previewHasChanges(preview);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  onCancelRef.current = onCancel;
  busyRef.current = busy;

  useEffect(() => {
    confirmRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (busyRef.current) return;
      onCancelRef.current();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-confirm-title"
    >
      <form
        className="w-[440px] max-w-[90vw] rounded-xl border border-line bg-surface-elevated p-5 shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          if (!empty) onConfirm();
          else onCancel();
        }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="sync-confirm-title" className="text-[13px] font-semibold text-ink">
            {copy.title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded p-0.5 text-ink-subtle hover:bg-hover hover:text-ink disabled:opacity-50"
          >
            <X size={15} />
          </button>
        </div>
        <p className="mb-3 whitespace-pre-wrap text-[12px] leading-5 text-ink-muted">{copy.message}</p>
        {!empty && (
          <div className="mb-4 max-h-48 space-y-3 overflow-auto text-[12px] leading-5">
            <PathGroup label="覆盖" paths={preview.modified} total={preview.modified_count} />
            <PathGroup label="删除" paths={preview.deleted} total={preview.deleted_count} />
          </div>
        )}
        <div className="flex justify-end gap-2">
          {!empty && (
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink disabled:opacity-50"
              onClick={onCancel}
              disabled={busy}
            >
              取消
            </button>
          )}
          <button
            ref={confirmRef}
            type="submit"
            disabled={busy}
            className={
              !empty && copy.danger
                ? "rounded-md bg-(--color-danger) px-3 py-1.5 text-[12px] text-white hover:opacity-90 disabled:opacity-50"
                : "rounded-md bg-btn px-3 py-1.5 text-[12px] text-btn-fg hover:opacity-90 disabled:opacity-50"
            }
          >
            {empty ? "关闭" : direction === "upload" ? "上传" : "下载"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export function GitPatchScanDialog() {
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="git-patch-scan-title"
    >
      <div className="w-[400px] max-w-[90vw] rounded-xl border border-line bg-surface-elevated p-5 shadow-2xl">
        <h2 id="git-patch-scan-title" className="mb-3 text-[13px] font-semibold text-ink">
          拉取改动
        </h2>
        <p className="text-[12px] leading-5 text-ink-muted">正在扫描远程未提交改动…</p>
      </div>
    </div>,
    document.body,
  );
}

export function GitPatchConfirmDialog({
  preview,
  onConfirm,
  onCancel,
  busy = false,
}: {
  preview: GitPatchPreview;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const copy = gitPatchConfirmCopy(preview);
  const empty = !gitPatchHasChanges(preview);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  onCancelRef.current = onCancel;
  busyRef.current = busy;

  useEffect(() => {
    confirmRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (busyRef.current) return;
      onCancelRef.current();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="git-patch-confirm-title"
    >
      <form
        className="w-[440px] max-w-[90vw] rounded-xl border border-line bg-surface-elevated p-5 shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          if (!empty) onConfirm();
          else onCancel();
        }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="git-patch-confirm-title" className="text-[13px] font-semibold text-ink">
            {copy.title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded p-0.5 text-ink-subtle hover:bg-hover hover:text-ink disabled:opacity-50"
          >
            <X size={15} />
          </button>
        </div>
        <p className="mb-3 whitespace-pre-wrap text-[12px] leading-5 text-ink-muted">{copy.message}</p>
        {!empty && (
          <div className="mb-4 max-h-48 space-y-3 overflow-auto text-[12px] leading-5">
            <PathGroup label="增加" paths={preview.added} total={preview.added_count} />
            <PathGroup label="覆盖" paths={preview.modified} total={preview.modified_count} />
            <PathGroup label="删除" paths={preview.deleted} total={preview.deleted_count} />
          </div>
        )}
        <div className="flex justify-end gap-2">
          {!empty && (
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink disabled:opacity-50"
              onClick={onCancel}
              disabled={busy}
            >
              取消
            </button>
          )}
          <button
            ref={confirmRef}
            type="submit"
            disabled={busy}
            className={
              !empty && copy.danger
                ? "rounded-md bg-(--color-danger) px-3 py-1.5 text-[12px] text-white hover:opacity-90 disabled:opacity-50"
                : "rounded-md bg-btn px-3 py-1.5 text-[12px] text-btn-fg hover:opacity-90 disabled:opacity-50"
            }
          >
            {empty ? "关闭" : "应用"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function PathGroup({ label, paths, total }: { label: string; paths: string[]; total: number }) {
  if (total <= 0) return null;
  const { shown, hidden } = listedPreviewPaths(paths, total);
  return (
    <div>
      <div className="mb-1 text-[11px] text-ink-subtle">
        {label} {total} 个
      </div>
      <ul className="space-y-0.5 text-ink">
        {shown.map((path) => (
          <li key={`${label}-${path}`} className="truncate font-mono text-[11px]" title={path}>
            {path}
          </li>
        ))}
      </ul>
      {hidden > 0 && <div className="mt-1 text-[11px] text-ink-subtle">还有 {hidden} 个</div>}
    </div>
  );
}
