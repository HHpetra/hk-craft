import { useEffect } from "react";
import { useWorkspace } from "../../store/workspace";

export function Toast() {
  const notice = useWorkspace((s) => s.notice);
  const setNotice = useWorkspace((s) => s.setNotice);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice, setNotice]);

  if (!notice) return null;

  return (
    <div className="toast-enter fixed bottom-4 left-1/2 z-50 max-w-[80vw] -translate-x-1/2 rounded-lg border border-line bg-surface-elevated px-3.5 py-2.5 text-ink shadow-xl">
      <div className="flex items-start gap-3">
        <span className="break-all leading-relaxed">{notice}</span>
        <button
          type="button"
          className="shrink-0 text-[11px] text-ink-subtle hover:text-ink"
          onClick={() => setNotice(null)}
        >
          关闭
        </button>
      </div>
    </div>
  );
}
