export const PTY_QUIET_MS = 400;
export const PTY_QUIET_TIMEOUT_MS = 8000;

export type PtyWaitStatus = "quiet" | "timeout" | "exited" | "cancelled";

export type PtyWaitResult = { status: PtyWaitStatus; output: string };

export function quietWaitShouldResolve(input: {
  startedAt: number;
  lastOutputAt: number | null;
  now: number;
  quietMs: number;
  timeoutMs: number;
}) {
  if (input.now - input.startedAt >= input.timeoutMs) return true;
  if (input.lastOutputAt == null) return false;
  return input.now - input.lastOutputAt >= input.quietMs;
}

/** Inject while the PTY is still alive — including a silent shell with no MOTD. */
export function shouldInjectPostWrite(status: PtyWaitStatus, _output = ""): boolean {
  return status === "quiet" || status === "timeout";
}
