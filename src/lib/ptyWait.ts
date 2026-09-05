import { ptyKill, ptyList } from "./api";
import {
  PTY_QUIET_MS,
  PTY_QUIET_TIMEOUT_MS,
  classifyResumeBootOutput,
  quietWaitShouldResolve,
  type PtyWaitResult,
  type PtyWaitStatus,
} from "./ptyQuiet";
import { ensurePtyExitListener, ensurePtyOutputListener, subscribePtyExit, subscribePtyOutput } from "./termRegistry";

export { PTY_QUIET_MS, PTY_QUIET_TIMEOUT_MS, quietWaitShouldResolve, shouldInjectPostWrite, classifyResumeBootOutput } from "./ptyQuiet";
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

/** Watch a just-spawned --resume process: fatal boot → retry bare; painted TUI → keep it. */
export function waitResumeBootOutcome(
  sessionId: string,
  generation: number,
  timeoutMs = 20000,
): Promise<"fatal" | "alive"> {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let unsubOut: (() => void) | undefined;
    let unsubExit: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: "fatal" | "alive") => {
      if (settled) return;
      settled = true;
      if (timer != null) window.clearTimeout(timer);
      unsubOut?.();
      unsubExit?.();
      resolve(value);
    };
    unsubOut = subscribePtyOutput((id, data, incoming) => {
      if (id !== sessionId) return;
      if (!generationMatches(generation, incoming)) return;
      output += data;
      const kind = classifyResumeBootOutput(output);
      if (kind === "fatal") finish("fatal");
      else if (kind === "alive") finish("alive");
    });
    unsubExit = subscribePtyExit((id, incoming) => {
      if (id !== sessionId) return;
      if (!generationMatches(generation, incoming)) return;
      // Died before alt-screen: --resume failed. A later /exit after the TUI
      // mounted already resolved "alive" above.
      finish(classifyResumeBootOutput(output) === "alive" ? "alive" : "fatal");
    });
    void ensurePtyOutputListener();
    void ensurePtyExitListener();
    timer = window.setTimeout(() => {
      void ptyList().then((ids) => {
        finish(ids.includes(sessionId) ? "alive" : "fatal");
      });
    }, timeoutMs);
  });
}

export async function clearPtySession(sessionId: string) {
  try {
    await ptyKill(sessionId);
  } catch {
    // already gone
  }
  await waitPtySessionGone(sessionId);
}
