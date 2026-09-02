import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { commitPathDrop, injectDroppedPaths, peekPathDrag, sessionAtPoint } from "../lib/dnd";
import { parseSessionId } from "../lib/format";

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
        const session = sessionAtPoint(x, y);

        if (osPaths.length) {
          if (!session || !parseSessionId(session)) return;
          injectDroppedPaths(session, osPaths);
          return;
        }

        if (peekPathDrag()?.length) {
          commitPathDrop(session);
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
