import { createPortal } from "react-dom";
import type { SyncDirection, SyncProgress } from "../../types";
import { clampPercent, syncProgressDetail, syncProgressTitle } from "../../lib/syncProgress";

export function SyncProgressDialog({
  direction,
  progress,
  onClose,
}: {
  direction: SyncDirection;
  progress: SyncProgress;
  onClose: () => void;
}) {
  const done = progress.phase === "done" || progress.phase === "error";
  const percent = clampPercent(progress.percent);
  const title = syncProgressTitle(direction, progress.phase);
  const failed = progress.phase === "error";

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-progress-title"
    >
      <div className="w-[400px] max-w-[90vw] rounded-xl border border-line bg-surface-elevated p-5 shadow-2xl">
        <h2 id="sync-progress-title" className="mb-4 text-[13px] font-semibold text-ink">
          {title}
        </h2>
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-field">
          <div
            className={`h-full rounded-full ${failed ? "bg-(--color-danger)" : "bg-btn"}`}
            style={{ width: `${failed ? 100 : percent}%` }}
          />
        </div>
        <div className="mb-1 text-[11px] text-ink-muted">{failed ? "" : `${percent}%`}</div>
        <p className="mb-5 whitespace-pre-wrap text-[12px] leading-5 text-ink-muted">
          {syncProgressDetail(progress)}
        </p>
        {done && (
          <div className="flex justify-end">
            <button
              type="button"
              className="rounded-md bg-btn px-3 py-1.5 text-[12px] text-btn-fg hover:opacity-90"
              onClick={onClose}
            >
              关闭
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
