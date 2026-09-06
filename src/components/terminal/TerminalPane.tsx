import { useEffect, useRef } from "react";
import { copyOnSelectForCommand, resolveAgentCommand } from "../../lib/agentProtocol";
import { cn, parseSessionId } from "../../lib/format";
import {
  fitAndResize,
  getOrCreateTerminal,
  scheduleFitAndResize,
  setSessionCopyOnSelect,
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

function copyOnSelectForSession(sessionId: string) {
  const parsed = parseSessionId(sessionId);
  if (parsed?.kind !== "agent") return false;
  const state = useWorkspace.getState();
  const project = state.config?.projects.find((item) => item.id === parsed.projectId);
  const pane = project?.panes.find((item) => item.id === parsed.paneId);
  if (!project || !pane) return false;
  return copyOnSelectForCommand(resolveAgentCommand(pane, project, state.config?.agent_presets ?? []));
}

export function TerminalPane({ sessionId, kind, interactive }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const status = useWorkspace((s) => s.sessionStatus[sessionId] ?? "idle");
  const restartPane = useWorkspace((s) => s.restartPane);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let ro: ResizeObserver | null = null;

    function mount() {
      setSessionCopyOnSelect(sessionId, copyOnSelectForSession(sessionId));
      const entry: RegistryEntry = getOrCreateTerminal(sessionId);
      if (cancelled || !container) return;
      if (entry.host.parentElement !== container) {
        container.replaceChildren(entry.host);
      }
      ro = new ResizeObserver(() => {
        if (!interactive) return;
        scheduleFitAndResize(sessionId, entry);
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

  const parsed = parseSessionId(sessionId);

  return (
    <div className={cn("relative h-full w-full", !interactive && "pointer-events-none")}>
      <div ref={containerRef} className="h-full w-full" />
      {(status === "exited" || status === "error") && parsed && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/55">
          <button
            type="button"
            className="rounded-md bg-btn px-3 py-1.5 text-btn-fg hover:opacity-90"
            onClick={() => void restartPane(parsed.projectId, parsed.paneId)}
          >
            重新启动
          </button>
        </div>
      )}
    </div>
  );
}
