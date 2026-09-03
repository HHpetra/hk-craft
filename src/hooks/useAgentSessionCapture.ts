import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWorkspace } from "../store/workspace";

const POLL_MS = 2500;

export function useAgentSessionCapture() {
  const openedProjectIds = useWorkspace((s) => s.openedProjectIds);
  const captureOpenedAgentSessions = useWorkspace((s) => s.captureOpenedAgentSessions);
  const snapshotOpenedSessions = useWorkspace((s) => s.snapshotOpenedSessions);

  useEffect(() => {
    let cancelled = false;

    async function capture() {
      if (cancelled) return;
      await captureOpenedAgentSessions();
    }

    void capture();
    const timer = window.setInterval(() => {
      void capture();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [openedProjectIds, captureOpenedAgentSessions]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let closing = false;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (closing) return;
        event.preventDefault();
        try {
          await snapshotOpenedSessions();
        } finally {
          closing = true;
          unlisten?.();
          await getCurrentWindow().destroy();
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [snapshotOpenedSessions]);
}
