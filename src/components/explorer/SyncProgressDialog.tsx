import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { SyncDirection, SyncProgress } from "../../types";
import { clampPercent, syncProgressTitle } from "../../lib/syncProgress";

export function SyncProgressDialog({
  direction,
  progress,
  log,
  onClose,
}: {
  direction: SyncDirection;
  progress: SyncProgress;
  log: string[];
  onClose: () => void;
}) {
  const done = progress.phase === "done" || progress.phase === "error";
  const percent = clampPercent(progress.percent);
  const title = syncProgressTitle(direction, progress.phase);
  const failed = progress.phase === "error";
  const logRef = useRef<HTMLTextAreaElement>(null);
  const logText = log.join("\n");

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logText]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-progress-title"
    >
      <div className="w-[440px] max-w-[90vw] rounded-xl border border-line bg-surface-elevated p-5 shadow-2xl">
        <h2 id="sync-progress-title" className="mb-4 text-[13px] font-semibold text-ink">
          {title}
        </h2>
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-field">
          <div
            className={`h-full rounded-full ${failed ? "bg-(--color-danger)" : "bg-btn"}`}
            style={{ width: `${failed ? 100 : percent}%` }}
          />
        </div>
        <div className="mb-3 text-[11px] text-ink-muted">
          {failed ? "" : progress.speed ? `${percent}% · ${progress.speed}` : `${percent}%`}
        </div>
        <div className="mb-3 grid grid-cols-3 gap-2 text-center">
          <CountCell label="增加" value={progress.added} />
          <CountCell label="修改" value={progress.modified} />
          <CountCell label="删除" value={progress.deleted} />
        </div>
        <textarea
          ref={logRef}
          readOnly
          value={logText}
          aria-label="同步文件列表"
          className="mb-3 h-40 w-full resize-none rounded-md border border-line bg-field px-2.5 py-2 font-mono text-[11px] leading-4 text-ink outline-none"
        />
        {failed && (
          <p className="mb-3 whitespace-pre-wrap text-[12px] leading-5 text-(--color-danger)">
            {progress.message || "同步失败"}
          </p>
        )}
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

function CountCell({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-[11px] text-ink-subtle">{label}</div>
      <div className="text-[13px] tabular-nums text-ink">{value}</div>
    </div>
  );
}
