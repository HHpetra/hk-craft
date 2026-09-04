import type { SpawnOpts, SpawnResult } from "../types";
import { shouldInjectPostWrite, type PtyWaitResult, type PtyWaitStatus } from "./ptyQuiet";

/** How long to watch a Docker exec before assuming /bin/sh actually stayed up. */
export const PTY_EXEC_PROBE_MS = 2000;

export const DEFAULT_DOCKER_SHELLS = ["/bin/sh", "/bin/bash"];

export type DockerLaunchInput = {
  sessionId: string;
  cwd: string;
  container: string;
  shells: string[];
  postWrite: string | null;
  killFirst: boolean;
  signal?: AbortSignal;
};

export type QuietWaitHandle = {
  promise: Promise<PtyWaitResult>;
  cancel: () => void;
  observeGeneration: (generation: number) => void;
};

export type LaunchDeps = {
  ensureRunning: (name: string) => Promise<void>;
  spawn: (opts: SpawnOpts) => Promise<SpawnResult>;
  write: (sessionId: string, data: string) => Promise<void>;
  clearSession: (sessionId: string) => Promise<void>;
  waitQuiet: (sessionId: string, options?: { quietMs?: number; timeoutMs?: number }) => QuietWaitHandle;
  kill: (sessionId: string) => Promise<void>;
  clearTerminal: (sessionId: string) => void;
  sessionExists: (sessionId: string) => Promise<boolean>;
};

export type DockerExecFailKind = "missing-shell" | "daemon" | "permission" | "not-running" | "unknown";

export type PtyExecClass = "ok" | "missing-shell" | "exec-fail";

export type LaunchOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "empty-container" | "ensure" | "no-shell" | "spawn" | "exec" | "cancelled";
      detail: string;
    }
  | { ok: false; reason: "inject"; detail: string; sessionAlive: boolean };

const CANCELLED: LaunchOutcome = { ok: false, reason: "cancelled", detail: "已取消" };

/** Docker/OCI missing-interpreter errors — not generic MOTD "no such file" lines. */
export function looksLikeMissingShell(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("executable file not found")) return true;
  const missing = lower.includes("no such file") || lower.includes("not found in $path");
  if (!missing) return false;
  return lower.includes("exec:") || lower.includes("stat /bin/sh") || lower.includes("stat /bin/bash");
}

export function classifyDockerExecOutput(text: string): DockerExecFailKind {
  if (looksLikeMissingShell(text)) return "missing-shell";
  const lower = text.toLowerCase();
  if (lower.includes("permission denied") || lower.includes("access denied")) return "permission";
  if (
    lower.includes("cannot connect to the docker daemon") ||
    lower.includes("is the docker daemon running") ||
    lower.includes("cannot connect to the docker engine") ||
    lower.includes("error during connect")
  ) {
    return "daemon";
  }
  if (
    lower.includes("is not running") ||
    lower.includes("is paused") ||
    lower.includes("no such container") ||
    lower.includes("no such object")
  ) {
    return "not-running";
  }
  return "unknown";
}

export function classifyPtyExec(status: PtyWaitStatus, output = ""): PtyExecClass {
  const kind = classifyDockerExecOutput(output);
  if (kind === "missing-shell") return "missing-shell";
  if (kind === "daemon" || kind === "permission" || kind === "not-running") return "exec-fail";
  if (status === "exited") return "exec-fail";
  return "ok";
}

export function dockerExecFailDetail(output: string): string {
  const trimmed = output.trim();
  switch (classifyDockerExecOutput(output)) {
    case "missing-shell":
      return "容器内找不到可用 shell";
    case "daemon":
      return trimmed || "无法连接 Docker daemon";
    case "permission":
      return trimmed || "没有权限执行 docker exec";
    case "not-running":
      return trimmed || "容器未在运行";
    default:
      return trimmed || "docker exec 立即退出";
  }
}

export function dockerLaunchNotice(outcome: LaunchOutcome): string | null {
  if (outcome.ok) return null;
  if (outcome.reason === "cancelled") return null;
  if (outcome.reason === "empty-container") return "Docker 启动失败：未指定容器";
  if (outcome.reason === "inject") {
    return outcome.sessionAlive ? `未能执行自动命令：${outcome.detail}` : `Docker 启动失败：${outcome.detail}`;
  }
  return `Docker 启动失败：${outcome.detail}`;
}

export function dockerLaunchStatus(outcome: LaunchOutcome): "running" | "error" | "idle" {
  if (outcome.ok) return "running";
  if (outcome.reason === "cancelled") return "idle";
  if (outcome.reason === "inject" && outcome.sessionAlive) return "running";
  return "error";
}

export function dockerExecOpts(input: Pick<DockerLaunchInput, "sessionId" | "cwd" | "container">, shell: string): SpawnOpts {
  return {
    sessionId: input.sessionId,
    cwd: input.cwd,
    command: "docker",
    args: ["exec", "-i", "-t", input.container, shell],
  };
}

function aborted(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

async function discardIfAborted(deps: LaunchDeps, sessionId: string, signal?: AbortSignal): Promise<LaunchOutcome | null> {
  if (!aborted(signal)) return null;
  try {
    await deps.clearSession(sessionId);
  } catch {
    // already gone
  }
  return CANCELLED;
}

export async function executeDockerLaunch(input: DockerLaunchInput, deps: LaunchDeps): Promise<LaunchOutcome> {
  const container = input.container.trim();
  if (!container) {
    return { ok: false, reason: "empty-container", detail: "未指定容器" };
  }

  const sessionId = input.sessionId;
  const signal = input.signal;
  if (aborted(signal)) return CANCELLED;

  if (input.killFirst) {
    try {
      await deps.kill(sessionId);
    } catch {
      // already gone
    }
    deps.clearTerminal(sessionId);
    const cancelled = await discardIfAborted(deps, sessionId, signal);
    if (cancelled) return cancelled;
  }

  try {
    await deps.ensureRunning(container);
  } catch (err) {
    if (aborted(signal)) return CANCELLED;
    return { ok: false, reason: "ensure", detail: String(err) };
  }
  const afterEnsure = await discardIfAborted(deps, sessionId, signal);
  if (afterEnsure) return afterEnsure;

  const shells = input.shells.length > 0 ? input.shells : DEFAULT_DOCKER_SHELLS;
  const timeoutMs = input.postWrite ? undefined : PTY_EXEC_PROBE_MS;
  let lastSpawnError: unknown;

  for (let index = 0; index < shells.length; index += 1) {
    const shell = shells[index];
    if (!shell) continue;
    const last = index === shells.length - 1;
    const beforeSpawn = await discardIfAborted(deps, sessionId, signal);
    if (beforeSpawn) return beforeSpawn;
    try {
      const { result, waited } = await spawnWithWatch(deps, dockerExecOpts({ ...input, container }, shell), timeoutMs);
      const afterSpawn = await discardIfAborted(deps, sessionId, signal);
      if (afterSpawn) return afterSpawn;
      if (result.reused) {
        if (index > 0) {
          return { ok: false, reason: "no-shell", detail: "无法切换到备用 shell" };
        }
        return { ok: true };
      }
      const kind = waited ? classifyPtyExec(waited.status, waited.output) : "ok";
      if (kind === "missing-shell") {
        if (!last) {
          await deps.clearSession(sessionId);
          continue;
        }
        return { ok: false, reason: "no-shell", detail: "容器内找不到可用 shell" };
      }
      if (kind === "exec-fail") {
        if (waited?.status !== "exited") {
          try {
            await deps.clearSession(sessionId);
          } catch {
            // already gone
          }
        }
        return { ok: false, reason: "exec", detail: dockerExecFailDetail(waited?.output ?? "") };
      }
      return await injectPostWrite(input, deps, waited, result.reused);
    } catch (err) {
      lastSpawnError = err;
      if (aborted(signal)) return CANCELLED;
      if (last) {
        return { ok: false, reason: "spawn", detail: String(err) };
      }
    }
  }

  return { ok: false, reason: "spawn", detail: String(lastSpawnError ?? "启动失败") };
}

async function spawnWithWatch(
  deps: LaunchDeps,
  opts: SpawnOpts,
  timeoutMs: number | undefined,
): Promise<{ result: SpawnResult; waited: PtyWaitResult | null }> {
  const watch = deps.waitQuiet(opts.sessionId, timeoutMs != null ? { timeoutMs } : undefined);
  try {
    const result = await deps.spawn(opts);
    if (result.reused) {
      watch.cancel();
      return { result, waited: null };
    }
    watch.observeGeneration(result.generation);
    return { result, waited: await watch.promise };
  } catch (err) {
    watch.cancel();
    throw err;
  }
}

async function injectPostWrite(
  input: DockerLaunchInput,
  deps: LaunchDeps,
  waited: PtyWaitResult | null,
  reused: boolean,
): Promise<LaunchOutcome> {
  if (aborted(input.signal)) {
    return (await discardIfAborted(deps, input.sessionId, input.signal)) ?? CANCELLED;
  }
  if (!input.postWrite || reused) return { ok: true };
  if (!waited || !shouldInjectPostWrite(waited.status, waited.output)) {
    if (waited?.status === "exited") {
      return { ok: false, reason: "inject", detail: "会话已退出，未能执行自动命令", sessionAlive: false };
    }
    return { ok: true };
  }
  try {
    await deps.write(input.sessionId, input.postWrite);
    return { ok: true };
  } catch (err) {
    let sessionAlive = false;
    try {
      sessionAlive = await deps.sessionExists(input.sessionId);
    } catch {
      sessionAlive = false;
    }
    return { ok: false, reason: "inject", detail: String(err), sessionAlive };
  }
}
