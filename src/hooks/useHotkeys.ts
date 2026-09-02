import { useEffect } from "react";
import type { WorkspaceLayout } from "../types";
import { useWorkspace } from "../store/workspace";

export function useHotkeys() {
  const setLayout = useWorkspace((s) => s.setLayout);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        !target.closest(".xterm") &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const map: Record<string, WorkspaceLayout> = {
        "1": "tabs",
        "2": "row",
        "3": "grid",
      };
      const layout = map[event.key];
      if (!layout) return;
      event.preventDefault();
      event.stopPropagation();
      void setLayout(layout);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [setLayout]);
}
