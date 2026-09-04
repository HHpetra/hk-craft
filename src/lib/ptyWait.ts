import { ptyKill, ptyList } from "./api";
import {
  PTY_QUIET_MS,
  PTY_QUIET_TIMEOUT_MS,
  quietWaitShouldResolve,
  type PtyWaitResult,
  type PtyWaitStatus,
} from "./ptyQuiet";
import { ensurePtyExitListener, ensurePtyOutputListener, subscribePtyExit, subscribePtyOutput } from "./termRegistry";

export { PTY_QUIET_MS, PTY_QUIET_TIMEOUT_MS, quietWaitShouldResolve, shouldInjectPostWrite } from "./ptyQuiet";
export type { PtyWaitResult, PtyWaitStatus } from "./ptyQuiet";

type PendingEvent =
  | { kind: "output"; data: string; generation: number }
  | { kind: "exit"; generation: number };

function generationMatches(armed: number, incoming: number) {
  if (incoming === 0 || armed === 0) return true;
  return incoming === armed;
}

export function waitPtyQuiet(
  sessionId: string,
  options?: { quietMs?: number; timeoutMs?: number },
): {
  promise: Promise<PtyWaitResult>;
  cancel: () => void;
  observeGeneration: (generation: number) => void;
} {
  const quietMs = options?.quietMs ?? PTY_QUIET_MS;
  const timeoutMs = options?.timeoutMs ?? PTY_QUIET_TIMEOUT_MS;
  let settled = false;
  let lastOutputAt: number | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let output = "";
  let armedGen: number | null = null;
  let startedAt = 0;
  const pending: PendingEvent[] = [];
  let unsubOut: (() => void) | undefined;
  let unsubExit: (() => void) | undefined;
  let resolvePromise: (result: PtyWaitResult) => void = () => undefined;

  const finish = (status: PtyWaitStatus) => {
    if (settled) return;
    settled = true;
    if (timeout != null) window.clearTimeout(timeout);
    if (quietTimer) window.clearTimeout(quietTimer);
    unsubOut?.();
    unsubExit?.();
    resolvePromise({ status, output });
  };

  const armClock = () => {
    if (settled || startedAt) return;
    startedAt = Date.now();
    timeout = window.setTimeout(() => finish("timeout"), timeoutMs);
  };

  const handleOutput = (generation: number, data: string) => {
    if (settled) return;
    if (armedGen == null) {
      pending.push({ kind: "output", data, generation });
      return;
    }
    if (!generationMatches(armedGen, generation)) return;
    output += data;
    lastOutputAt = Date.now();
    if (quietTimer) window.clearTimeout(quietTimer);
    quietTimer = window.setTimeout(() => {
      if (
        quietWaitShouldResolve({
          startedAt,
          lastOutputAt,
          now: Date.now(),
          quietMs,
          timeoutMs,
        })
      ) {
        finish("quiet");
      }
    }, quietMs);
  };

  const handleExit = (generation: number) => {
    if (settled) return;
    if (armedGen == null) {
      pending.push({ kind: "exit", generation });
      return;
    }
    if (!generationMatches(armedGen, generation)) return;
    finish("exited");
  };

  unsubOut = subscribePtyOutput((id, data, generation) => {
    if (id !== sessionId) return;
    handleOutput(generation, data);
  });
  unsubExit = subscribePtyExit((id, generation) => {
    if (id !== sessionId) return;
    handleExit(generation);
  });

  void ensurePtyOutputListener();
  void ensurePtyExitListener();

  const promise = new Promise<PtyWaitResult>((resolve) => {
    resolvePromise = resolve;
    if (settled) resolve({ status: "cancelled", output });
  });

  return {
    promise,
    cancel: () => finish("cancelled"),
    observeGeneration: (generation: number) => {
      if (settled) return;
      armedGen = generation;
      const queued = pending.splice(0);
      for (const event of queued) {
        if (event.kind === "output") handleOutput(event.generation, event.data);
        else handleExit(event.generation);
      }
      armClock();
    },
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export async function waitPtySessionGone(sessionId: string, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ids = await ptyList();
    if (!ids.includes(sessionId)) return;
    await sleep(50);
  }
}

export async function clearPtySession(sessionId: string) {
  try {
    await ptyKill(sessionId);
  } catch {
    // already gone
  }
  await waitPtySessionGone(sessionId);
}
