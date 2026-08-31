import { useEffect } from "react";
import type { ViewMode } from "../types";

export function useHotkeys(setViewMode: (mode: ViewMode) => void) {
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
      const map: Record<string, ViewMode> = {
        "1": "explorer",
        "2": "agent",
        "3": "runner",
        "4": "tiled",
      };
      const mode = map[event.key];
      if (!mode) return;
      event.preventDefault();
      event.stopPropagation();
      setViewMode(mode);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [setViewMode]);
}
