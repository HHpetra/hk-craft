export const ECHO_GRACE_MS = 400;
export const SILENCE_MS = 1500;
export const NOTIFY_BUSY_MS = 8000;
/** Silence after typing/deleting is "waiting for the user", not task completion. */
export const USER_WAIT_MS = SILENCE_MS + 1000;

export type PtyActivityTrack = {
  lastOutput: number;
  lastUserWrite: number;
  runningSince: number | null;
  /** Last time output went silent long enough to count as idle-at-prompt. */
  idleSince: number | null;
  timer: ReturnType<typeof setTimeout> | null;
};

export type PtySilenceDecision = {
  notify: boolean;
  toWaiting: boolean;
};

export type PtyExitDecision = {
  notify: boolean;
  status: "exited" | "error";
};

const tracks = new Map<string, PtyActivityTrack>();

export function createPtyActivityTrack(): PtyActivityTrack {
  return { lastOutput: 0, lastUserWrite: 0, runningSince: null, idleSince: null, timer: null };
}

export function getPtyActivity(sessionId: string): PtyActivityTrack {
  let track = tracks.get(sessionId);
  if (!track) {
    track = createPtyActivityTrack();
    tracks.set(sessionId, track);
  }
  return track;
}

export function clearPtyTimer(track: PtyActivityTrack) {
  if (track.timer) {
    clearTimeout(track.timer);
    track.timer = null;
  }
}

/** Keystrokes, paste, and injects — not OSC replies. Clears the busy clock so TUI echo is not a "task". */
export function notePtyUserInput(sessionId: string, now = Date.now()) {
  const track = getPtyActivity(sessionId);
  track.lastUserWrite = now;
  track.runningSince = null;
}

export function isPtyEcho(track: PtyActivityTrack, now = Date.now()) {
  return track.lastUserWrite > 0 && now - track.lastUserWrite < ECHO_GRACE_MS;
}

export function isRecentPtyUserInput(track: PtyActivityTrack, graceMs: number, now = Date.now()) {
  return track.lastUserWrite > 0 && now - track.lastUserWrite < graceMs;
}

export function shouldNotifyBusy(runningSince: number | null, now = Date.now()) {
  return runningSince !== null && now - runningSince >= NOTIFY_BUSY_MS;
}

export function markPtyIdle(track: PtyActivityTrack, now = Date.now()) {
  track.runningSince = null;
  track.idleSince = now;
}

/** A user-started task is still producing output — not spawn banners, prompt redraws, or typing. */
export function isInFlightTask(track: PtyActivityTrack, now = Date.now()) {
  return track.runningSince !== null && !isRecentPtyUserInput(track, USER_WAIT_MS, now);
}

function canStartBusyClock(track: PtyActivityTrack, now: number) {
  if (track.runningSince !== null) return false;
  if (isPtyEcho(track, now)) return false;
  if (track.lastUserWrite === 0) return false;
  if (track.idleSince !== null && track.lastUserWrite <= track.idleSince) return false;
  return true;
}

/** Bytes from the PTY. Echo, spawn banners, and idle TUI redraws do not start a busy clock. */
export function notePtyOutput(track: PtyActivityTrack, now = Date.now()) {
  track.lastOutput = now;
  if (!canStartBusyClock(track, now)) return;
  track.runningSince = now;
  track.idleSince = null;
}

export function decidePtySilence(
  track: PtyActivityTrack,
  currentStatus: string | undefined,
  now = Date.now(),
): PtySilenceDecision {
  if (currentStatus !== "running") return { notify: false, toWaiting: false };
  return {
    notify: !isRecentPtyUserInput(track, USER_WAIT_MS, now) && shouldNotifyBusy(track.runningSince, now),
    toWaiting: true,
  };
}

export function decidePtyExit(
  track: PtyActivityTrack,
  success: boolean,
  now = Date.now(),
): PtyExitDecision {
  const notify = shouldNotifyBusy(track.runningSince, now);
  track.runningSince = null;
  track.idleSince = now;
  return { notify, status: success ? "exited" : "error" };
}
