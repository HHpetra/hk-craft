import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import type { PtyExit, PtyOutput, SessionStatus } from "../types";
import { notifyTaskDone } from "../lib/notify";
import { sessionKindLabel } from "../lib/status";
import { isCurrentGeneration } from "../lib/termRegistry";
import { useWorkspace } from "../store/workspace";

const SILENCE_MS = 1500;
const NOTIFY_BUSY_MS = 8000;

type Track = {
  lastOutput: number;
  runningSince: number | null;
  timer: ReturnType<typeof setTimeout> | null;
};

const tracks = new Map<string, Track>();

function getTrack(id: string): Track {
  let track = tracks.get(id);
  if (!track) {
    track = { lastOutput: 0, runningSince: null, timer: null };
    tracks.set(id, track);
  }
  return track;
}

function clearTimer(track: Track) {
  if (track.timer) {
    clearTimeout(track.timer);
    track.timer = null;
  }
}

function kindFromSession(sessionId: string): "agent" | "runner" {
  return sessionId.endsWith(":runner") ? "runner" : "agent";
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
  const track = getTrack(sessionId);
  clearTimer(track);
  track.timer = setTimeout(() => {
    const state = useWorkspace.getState();
    const current = state.sessionStatus[sessionId];
    if (current !== "running") return;
    maybeNotify(sessionId, track.runningSince);
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
      if (!isCurrentGeneration(id, event.payload.generation ?? 0)) return;
      const track = getTrack(id);
      track.lastOutput = Date.now();
      if (track.runningSince === null) track.runningSince = Date.now();
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
      if (!isCurrentGeneration(id, event.payload.generation ?? 0)) return;
      const track = getTrack(id);
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
