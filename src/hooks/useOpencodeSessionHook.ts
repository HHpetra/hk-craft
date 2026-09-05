import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { assignmentFromOpencodeHook } from "../lib/opencodeHook";
import { useWorkspace } from "../store/workspace";
import type { OpencodeHookEvent } from "../types";

export function useOpencodeSessionHook() {
  const rememberAgentSession = useWorkspace((s) => s.rememberAgentSession);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void listen<OpencodeHookEvent>("agent-session", (event) => {
      const assignment = assignmentFromOpencodeHook(event.payload, useWorkspace.getState().config);
      if (!assignment) return;
      void rememberAgentSession(assignment.projectId, assignment.paneId, assignment.sessionId);
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [rememberAgentSession]);
}
