import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { openUrl } from "../../lib/api";
import { APP_RELEASES_URL, APP_VERSION } from "../../lib/appInfo";
import { checkAppUpdate, updatePromptCopy } from "../../lib/updateCheck";
import { useWorkspace } from "../../store/workspace";

export function UpdatePrompt() {
  const notice = useWorkspace((s) => s.notice);
  const setNotice = useWorkspace((s) => s.setNotice);
  const [latest, setLatest] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void checkAppUpdate().then((result) => {
      if (cancelled || result.status !== "outdated" || !result.latest) return;
      setLatest(result.latest);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed || !latest || notice) return null;

  const copy = updatePromptCopy(latest, APP_VERSION);

  function dismiss() {
    setDismissed(true);
  }

  function download() {
    void openUrl(APP_RELEASES_URL)
      .then(() => setDismissed(true))
      .catch((err) => setNotice(String(err)));
  }

  return (
    <div
      className="toast-enter fixed bottom-4 left-1/2 z-50 w-[360px] max-w-[90vw] -translate-x-1/2 rounded-lg border border-line bg-surface-elevated p-4 shadow-xl"
      role="status"
      aria-labelledby="update-prompt-title"
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <h2 id="update-prompt-title" className="text-[13px] font-semibold text-ink">
          {copy.title}
        </h2>
        <button
          type="button"
          className="rounded p-0.5 text-ink-subtle hover:bg-hover hover:text-ink"
          onClick={dismiss}
          aria-label="关闭"
        >
          <X size={15} />
        </button>
      </div>
      <p className="mb-4 text-[12px] leading-5 text-ink-muted">{copy.message}</p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rounded-md px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink"
          onClick={dismiss}
        >
          稍后
        </button>
        <button
          type="button"
          className="rounded-md bg-btn px-3 py-1.5 text-[12px] text-btn-fg hover:opacity-90"
          onClick={download}
        >
          前往下载
        </button>
      </div>
    </div>
  );
}
