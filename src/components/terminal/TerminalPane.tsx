import { useEffect, useRef } from "react";
import { cn } from "../../lib/format";
import {
  fitAndResize,
  getOrCreateTerminal,
  type RegistryEntry,
} from "../../lib/termRegistry";
import type { SessionKind } from "../../types";
import { useWorkspace } from "../../store/workspace";

export { applyRegisteredXtermTheme } from "../../lib/termRegistry";

interface TerminalPaneProps {
  sessionId: string;
  kind: SessionKind;
  interactive: boolean;
}

export function TerminalPane({ sessionId, kind, interactive }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const status = useWorkspace((s) => s.sessionStatus[sessionId] ?? "idle");
  const restartSession = useWorkspace((s) => s.restartSession);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let ro: ResizeObserver | null = null;

    function mount() {
      const entry: RegistryEntry = getOrCreateTerminal(sessionId);
      if (cancelled || !container) return;
      if (entry.host.parentElement !== container) {
        container.replaceChildren(entry.host);
      }
      ro = new ResizeObserver(() => {
        if (!interactive) return;
        requestAnimationFrame(() => fitAndResize(sessionId, entry));
      });
      ro.observe(container);
      requestAnimationFrame(() => fitAndResize(sessionId, entry));
    }

    mount();
    return () => {
      cancelled = true;
      ro?.disconnect();
    };
  }, [sessionId, kind, interactive]);

  const projectId = sessionId.split(":")[0];

  return (
    <div className={cn("relative h-full w-full", !interactive && "pointer-events-none")}>
      <div ref={containerRef} className="h-full w-full" />
      {(status === "exited" || status === "error") && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/55">
          <button
            type="button"
            className="rounded-md bg-btn px-3 py-1.5 text-btn-fg hover:opacity-90"
            onClick={() => void restartSession(projectId, kind)}
          >
            重新启动
          </button>
        </div>
      )}
    </div>
  );
}
