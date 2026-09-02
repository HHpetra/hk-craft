import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import type { PtyExit, PtyOutput } from "../types";
import { parseSessionId } from "../lib/format";
import { notifyTaskDone } from "../lib/notify";
import {
  clearPtyTimer,
  decidePtyExit,
  decidePtySilence,
  getPtyActivity,
  notePtyOutput,
  SILENCE_MS,
} from "../lib/ptyActivity";
import { sessionKindLabel } from "../lib/status";
import { isCurrentGeneration } from "../lib/termRegistry";
import { useWorkspace } from "../store/workspace";

function kindFromSession(sessionId: string): "agent" | "runner" {
  return parseSessionId(sessionId)?.kind ?? "agent";
}

function projectIdFromSession(sessionId: string) {
  return parseSessionId(sessionId)?.projectId ?? sessionId;
}

function isOpenedSession(sessionId: string) {
  const projectId = projectIdFromSession(sessionId);
  return useWorkspace.getState().openedProjectIds.includes(projectId);
}

function projectNameFor(sessionId: string) {
  const { config } = useWorkspace.getState();
  const project = config?.projects.find((p) => sessionId.startsWith(`${p.id}:`));
  return project?.name ?? "项目";
}

function notifyDone(sessionId: string) {
  const kind = kindFromSession(sessionId);
  void notifyTaskDone(
    `${projectNameFor(sessionId)} · ${sessionKindLabel(kind)}`,
    "任务已完成",
  );
}

function scheduleSilence(sessionId: string) {
  const track = getPtyActivity(sessionId);
  clearPtyTimer(track);
  track.timer = setTimeout(() => {
    const state = useWorkspace.getState();
    const decision = decidePtySilence(track, state.sessionStatus[sessionId]);
    if (!decision.toWaiting) return;
    if (decision.notify) notifyDone(sessionId);
    track.runningSince = null;
    state.setSessionStatus(sessionId, "waiting");
  }, SILENCE_MS);
}

export function usePtyStatusListener() {
  const setSessionStatus = useWorkspace((s) => s.setSessionStatus);

  useEffect(() => {
    let cancelled = false;
    const unsubs: Array<() => void> = [];

    void listen<PtyOutput>("pty-output", (event) => {
      const id = event.payload.session_id;
      if (!isOpenedSession(id)) return;
      if (!isCurrentGeneration(id, event.payload.generation ?? 0)) return;
      notePtyOutput(getPtyActivity(id));
      const current = useWorkspace.getState().sessionStatus[id];
      if (current !== "running") setSessionStatus(id, "running");
      scheduleSilence(id);
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unsubs.push(fn);
    });

    void listen<PtyExit>("pty-exit", (event) => {
      const id = event.payload.session_id;
      if (!isOpenedSession(id)) return;
      if (!isCurrentGeneration(id, event.payload.generation ?? 0)) return;
      const track = getPtyActivity(id);
      clearPtyTimer(track);
      const decision = decidePtyExit(track, event.payload.success);
      if (decision.notify) notifyDone(id);
      setSessionStatus(id, decision.status);
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unsubs.push(fn);
    });

    return () => {
      cancelled = true;
      unsubs.forEach((fn) => fn());
    };
  }, [setSessionStatus]);
}
