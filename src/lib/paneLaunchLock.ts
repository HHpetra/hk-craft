const inflight = new Map<string, AbortController>();
const pendingRelaunch = new Set<string>();

/** Returns an abort signal, or null when this session already has a launch running. */
export function beginPaneLaunch(sessionId: string): AbortSignal | null {
  if (inflight.has(sessionId)) return null;
  const abort = new AbortController();
  inflight.set(sessionId, abort);
  return abort.signal;
}

export function endPaneLaunch(sessionId: string) {
  inflight.delete(sessionId);
}

export function isPaneLaunching(sessionId: string): boolean {
  return inflight.has(sessionId);
}

/** Another restart arrived while launching. Abort current; restart after it ends. */
export function requestPaneRelaunch(sessionId: string) {
  pendingRelaunch.add(sessionId);
  inflight.get(sessionId)?.abort();
}

/** Pane or project is going away. Abort and drop any queued restart. */
export function cancelPaneLaunch(sessionId: string) {
  pendingRelaunch.delete(sessionId);
  inflight.get(sessionId)?.abort();
}

export function takePendingRelaunch(sessionId: string): boolean {
  const pending = pendingRelaunch.has(sessionId);
  pendingRelaunch.delete(sessionId);
  return pending;
}
