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
    <div className="fixed bottom-4 left-1/2 z-50 max-w-[80vw] -translate-x-1/2 rounded-md border border-line bg-surface-elevated px-3 py-2 text-ink shadow-lg">
      <div className="flex items-start gap-3">
        <span className="break-all">{notice}</span>
        <button type="button" className="text-ink-subtle hover:text-ink" onClick={() => setNotice(null)}>
          关闭
        </button>
      </div>
    </div>
  );
}
