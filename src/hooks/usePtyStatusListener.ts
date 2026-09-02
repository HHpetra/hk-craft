import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import type { PtyExit, PtyOutput, SessionStatus } from "../types";
import { parseSessionId } from "../lib/format";
import { notifyTaskDone } from "../lib/notify";
import {
  getPtyActivity,
  isPtyEcho,
  isRecentPtyUserInput,
  type PtyActivityTrack,
} from "../lib/ptyActivity";
import { sessionKindLabel } from "../lib/status";
import { isCurrentGeneration } from "../lib/termRegistry";
import { useWorkspace } from "../store/workspace";

const SILENCE_MS = 1500;
const NOTIFY_BUSY_MS = 8000;
/** Silence after typing/deleting is "waiting for the user", not task completion. */
const USER_WAIT_MS = SILENCE_MS + 1000;

function clearTimer(track: PtyActivityTrack) {
  if (track.timer) {
    clearTimeout(track.timer);
    track.timer = null;
  }
}

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

function maybeNotify(sessionId: string, runningSince: number | null) {
  if (!runningSince) return;
  if (Date.now() - runningSince < NOTIFY_BUSY_MS) return;
  const kind = kindFromSession(sessionId);
  void notifyTaskDone(
    `${projectNameFor(sessionId)} · ${sessionKindLabel(kind)}`,
    "任务已完成",
  );
}

function scheduleSilence(sessionId: string) {
  const track = getPtyActivity(sessionId);
  clearTimer(track);
  track.timer = setTimeout(() => {
    const state = useWorkspace.getState();
    const current = state.sessionStatus[sessionId];
    if (current !== "running") return;
    // Editing the Agent prompt (especially clearing it) redraws the TUI and
    // looks like a long-running job if we only watch output silence.
    if (!isRecentPtyUserInput(track, USER_WAIT_MS)) {
      maybeNotify(sessionId, track.runningSince);
    }
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
      const track = getPtyActivity(id);
      const now = Date.now();
      track.lastOutput = now;
      if (!isPtyEcho(track, now) && track.runningSince === null) {
        track.runningSince = now;
      }
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
      clearTimer(track);
      maybeNotify(id, track.runningSince);
      track.runningSince = null;
      const next: SessionStatus = event.payload.success ? "exited" : "error";
      setSessionStatus(id, next);
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
