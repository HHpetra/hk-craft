import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { listen } from "@tauri-apps/api/event";
import type { DragEvent } from "react";
import { ptyResize, ptyWrite } from "../../lib/api";
import { cn, formatAgentInject, formatRunnerInject } from "../../lib/format";
import { normalizeTheme, xtermThemes } from "../../lib/theme";
import type { PtyOutput, SessionKind } from "../../types";
import { useWorkspace } from "../../store/workspace";

type RegistryEntry = {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
};

const registry = new Map<string, RegistryEntry>();

function getOrCreateTerminal(sessionId: string): RegistryEntry {
  const existing = registry.get(sessionId);
  if (existing) return existing;

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Consolas, "Cascadia Code", "Courier New", monospace',
    theme: xtermThemes[normalizeTheme(document.documentElement.dataset.theme)],
    scrollback: 5000,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // canvas renderer fallback
  }

  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  term.open(host);

  term.onData((data) => {
    void ptyWrite(sessionId, data).catch(() => undefined);
  });

  void listen<PtyOutput>("pty-output", (event) => {
    if (event.payload.session_id === sessionId) {
      term.write(event.payload.data);
    }
  });

  registry.set(sessionId, { term, fit, host });
  return { term, fit, host };
}

export function applyRegisteredXtermTheme(theme: string) {
  const next = xtermThemes[normalizeTheme(theme)];
  for (const entry of registry.values()) {
    entry.term.options.theme = next;
  }
}

function fitAndResize(sessionId: string, entry: RegistryEntry) {
  const dims = entry.fit.proposeDimensions();
  if (!dims || dims.cols < 2 || dims.rows < 2) return;
  entry.fit.fit();
  void ptyResize(sessionId, entry.term.cols, entry.term.rows).catch(() => undefined);
}

interface TerminalPaneProps {
  sessionId: string;
  kind: SessionKind;
  interactive: boolean;
}

export function TerminalPane({ sessionId, kind, interactive }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prefix = useWorkspace((s) => {
    const project = s.config?.projects.find((p) => sessionId.startsWith(`${p.id}:`));
    const preset = s.config?.agent_presets.find((p) => p.id === project?.agent_preset);
    return preset?.drag_prefix ?? "@";
  });
  const status = useWorkspace((s) => s.sessionStatus[sessionId] ?? "idle");
  const restartSession = useWorkspace((s) => s.restartSession);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const entry = getOrCreateTerminal(sessionId);
    if (entry.host.parentElement !== container) {
      container.innerHTML = "";
      container.appendChild(entry.host);
    }
    const ro = new ResizeObserver(() => {
      if (!interactive) return;
      requestAnimationFrame(() => fitAndResize(sessionId, entry));
    });
    ro.observe(container);
    requestAnimationFrame(() => fitAndResize(sessionId, entry));
    return () => {
      ro.disconnect();
    };
  }, [sessionId, interactive]);

  function onDrop(event: DragEvent) {
    event.preventDefault();
    const path =
      event.dataTransfer.getData("application/x-workbench-path") ||
      event.dataTransfer.getData("text/plain");
    if (!path) return;
    const text =
      kind === "agent" ? formatAgentInject(path, prefix) : formatRunnerInject(path);
    void ptyWrite(sessionId, text).catch(() => undefined);
  }

  const projectId = sessionId.split(":")[0];

  return (
    <div
      className={cn("relative h-full w-full", !interactive && "pointer-events-none")}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={onDrop}
    >
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
