import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { discoverAgentSession } from "../lib/api";
import { sessionId } from "../lib/format";
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
      for (const projectId of openedProjectIds) {
        const project = config.projects.find((p) => p.id === projectId);
        if (!project) continue;
        const agentStatus = sessionStatus[sessionId(projectId, "agent")];
        if (agentStatus !== "running" && agentStatus !== "waiting") continue;
        const preset = config.agent_presets.find((p) => p.id === project.agent_preset);
        const command = preset?.command ?? "cursor-agent";
        try {
          const found = await discoverAgentSession(command, project.path);
          if (cancelled || !found) continue;
          await rememberAgentSession(projectId, found);
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
