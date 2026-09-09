import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "确定",
  cancelLabel = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    confirmRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
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
      aria-labelledby="confirm-dialog-title"
    >
      <form
        className="w-[400px] max-w-[90vw] rounded-xl border border-line bg-surface-elevated p-5 shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="confirm-dialog-title" className="text-[13px] font-semibold text-ink">
            {title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-0.5 text-ink-subtle hover:bg-hover hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
        <p className="mb-5 whitespace-pre-wrap text-[12px] leading-5 text-ink-muted">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="submit"
            className={
              danger
                ? "rounded-md bg-(--color-danger) px-3 py-1.5 text-[12px] text-white hover:opacity-90"
                : "rounded-md bg-btn px-3 py-1.5 text-[12px] text-btn-fg hover:opacity-90"
            }
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
