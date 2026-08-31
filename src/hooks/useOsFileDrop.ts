import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ptyWrite } from "../lib/api";
import { formatAgentInject, formatRunnerInject, sessionId } from "../lib/format";
import { useWorkspace } from "../store/workspace";

export function useOsFileDrop() {
  const activeProjectId = useWorkspace((s) => s.activeProjectId);
  const config = useWorkspace((s) => s.config);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const { paths, position } = event.payload;
        if (!paths.length) return;
        const factor = window.devicePixelRatio || 1;
        const x = "toLogical" in position && typeof position.toLogical === "function"
          ? position.toLogical(factor).x
          : position.x / factor;
        const y = "toLogical" in position && typeof position.toLogical === "function"
          ? position.toLogical(factor).y
          : position.y / factor;
        const el = document.elementFromPoint(x, y);
        const pane = el?.closest("[data-drop-kind]") as HTMLElement | null;
        const kind = pane?.getAttribute("data-drop-kind");
        if (kind !== "agent" && kind !== "runner") return;
        const projectId = useWorkspace.getState().activeProjectId;
        if (!projectId) return;
        const project = useWorkspace
          .getState()
          .config?.projects.find((p) => p.id === projectId);
        const preset = useWorkspace
          .getState()
          .config?.agent_presets.find((p) => p.id === project?.agent_preset);
        const prefix = preset?.drag_prefix ?? "@";
        const text = paths
          .map((path) =>
            kind === "agent" ? formatAgentInject(path, prefix) : formatRunnerInject(path),
          )
          .join("");
        void ptyWrite(sessionId(projectId, kind), text).catch(() => undefined);
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [activeProjectId, config]);
}
