import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { liveAgentTargets } from "../lib/agentProtocol";
import { discoverAgentSession } from "../lib/api";
import { useWorkspace } from "../store/workspace";

const POLL_MS = 2500;

export function useAgentSessionCapture() {
  const openedProjectIds = useWorkspace((s) => s.openedProjectIds);
  const rememberAgentSession = useWorkspace((s) => s.rememberAgentSession);
  const snapshotOpenedSessions = useWorkspace((s) => s.snapshotOpenedSessions);

  useEffect(() => {
    let cancelled = false;

    async function capture() {
      const { config, sessionStatus } = useWorkspace.getState();
      if (!config) return;
      for (const target of liveAgentTargets(config.projects, openedProjectIds, sessionStatus, config.agent_presets)) {
        try {
          const found = await discoverAgentSession(target.command, target.cwd);
          if (cancelled || !found) continue;
          await rememberAgentSession(target.projectId, target.paneId, found);
        } catch {
          // ignore
        }
      }
    }

    void capture();
    const timer = window.setInterval(() => {
      void capture();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [openedProjectIds, rememberAgentSession]);

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
