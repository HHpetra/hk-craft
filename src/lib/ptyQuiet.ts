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

/** dsh-tui throws this and refuses a fresh session when --resume cannot load the log. */
export function classifyResumeBootOutput(output: string): "fatal" | "alive" | "unknown" {
  if (
    /cannot resume session/i.test(output) ||
    /requires an interactive terminal/i.test(output) ||
    /drop --resume to start fresh/i.test(output)
  ) {
    return "fatal";
  }
  // Fullscreen Ink uses alt-screen. Launcher notes can be long; only this means the TUI mounted.
  if (/\x1b\[\??1049h/i.test(output) || /\x1b\[\??47h/i.test(output)) {
    return "alive";
  }
  return "unknown";
}
