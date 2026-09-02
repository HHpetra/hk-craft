export const ECHO_GRACE_MS = 400;

export type PtyActivityTrack = {
  lastOutput: number;
  lastUserWrite: number;
  runningSince: number | null;
  timer: ReturnType<typeof setTimeout> | null;
};

const tracks = new Map<string, PtyActivityTrack>();

export function getPtyActivity(sessionId: string): PtyActivityTrack {
  let track = tracks.get(sessionId);
  if (!track) {
    track = { lastOutput: 0, lastUserWrite: 0, runningSince: null, timer: null };
    tracks.set(sessionId, track);
  }
  return track;
}

/** Keystrokes, paste, and injects — not OSC replies. Clears the busy clock so TUI echo is not a "task". */
export function notePtyUserInput(sessionId: string) {
  const track = getPtyActivity(sessionId);
  track.lastUserWrite = Date.now();
  track.runningSince = null;
}

export function isPtyEcho(track: PtyActivityTrack, now = Date.now()) {
  return track.lastUserWrite > 0 && now - track.lastUserWrite < ECHO_GRACE_MS;
}

export function isRecentPtyUserInput(track: PtyActivityTrack, graceMs: number, now = Date.now()) {
  return track.lastUserWrite > 0 && now - track.lastUserWrite < graceMs;
}
