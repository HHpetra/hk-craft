import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { commitPathDrop, injectDroppedPaths, kindAtPoint, peekPathDrag } from "../lib/dnd";
import { useWorkspace } from "../store/workspace";

export function useOsFileDrop() {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const { paths: osPaths, position } = event.payload;
        const factor = window.devicePixelRatio || 1;
        const logical =
          typeof position.toLogical === "function" ? position.toLogical(factor) : null;
        const x = logical ? logical.x : position.x / factor;
        const y = logical ? logical.y : position.y / factor;
        const kind = kindAtPoint(x, y);

        if (osPaths.length) {
          const projectId = useWorkspace.getState().activeProjectId;
          if (!projectId || (kind !== "agent" && kind !== "runner")) return;
          const project = useWorkspace
            .getState()
            .config?.projects.find((p) => p.id === projectId);
          const preset = useWorkspace
            .getState()
            .config?.agent_presets.find((p) => p.id === project?.agent_preset);
          injectDroppedPaths(projectId, kind, osPaths, preset?.drag_prefix ?? "@");
          return;
        }

        if (peekPathDrag()?.length) {
          commitPathDrop(kind);
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
