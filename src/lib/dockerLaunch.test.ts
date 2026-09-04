import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCKER_SHELLS,
  classifyDockerExecOutput,
  classifyPtyExec,
  dockerExecFailDetail,
  dockerExecOpts,
  dockerLaunchNotice,
  dockerLaunchStatus,
  executeDockerLaunch,
  looksLikeMissingShell,
  type DockerLaunchInput,
  type LaunchDeps,
  type QuietWaitHandle,
} from "./dockerLaunch";
import type { SpawnOpts, SpawnResult } from "../types";
import type { PtyWaitResult } from "./ptyQuiet";

const baseInput: DockerLaunchInput = {
  sessionId: "p:docker:d1",
  cwd: "C:\\work",
  container: "web",
  shells: [...DEFAULT_DOCKER_SHELLS],
  postWrite: "cd /workspace\n",
  killFirst: false,
};

function waitHandle(result: PtyWaitResult): QuietWaitHandle {
  return {
    promise: Promise.resolve(result),
    cancel: () => undefined,
    observeGeneration: () => undefined,
  };
}

function spawnResult(generation: number, reused = false): SpawnResult {
  return { session_id: baseInput.sessionId, reused, generation };
}

function createDeps(overrides: Partial<LaunchDeps> = {}) {
  const spawned: SpawnOpts[] = [];
  const written: string[] = [];
  const cleared: string[] = [];
  const killed: string[] = [];
  const ensured: string[] = [];
  const deps: LaunchDeps = {
    ensureRunning: async (name) => {
      ensured.push(name);
    },
    spawn: async (opts) => {
      spawned.push(opts);
      return spawnResult(spawned.length);
    },
    write: async (_id, data) => {
      written.push(data);
    },
    clearSession: async (id) => {
      cleared.push(id);
    },
    waitQuiet: () => waitHandle({ status: "quiet", output: "$ " }),
    kill: async (id) => {
      killed.push(id);
    },
    clearTerminal: () => undefined,
    sessionExists: async () => true,
    ...overrides,
  };
  return { deps, spawned, written, cleared, killed, ensured };
}

describe("looksLikeMissingShell", () => {
  it("detects docker exec missing interpreter errors", () => {
    expect(looksLikeMissingShell('exec: "/bin/sh": stat /bin/sh: no such file or directory')).toBe(true);
    expect(looksLikeMissingShell("executable file not found in $PATH")).toBe(true);
    expect(
      looksLikeMissingShell('OCI runtime exec failed: exec failed: exec: "/bin/sh": stat /bin/sh: no such file'),
    ).toBe(true);
  });

  it("ignores MOTD or profile lines that mention no such file", () => {
    expect(looksLikeMissingShell("ls: cannot access /root/foo: No such file or directory")).toBe(false);
    expect(looksLikeMissingShell("$ echo hi")).toBe(false);
  });
});

describe("classifyDockerExecOutput", () => {
  it("classifies daemon, permission, and container-gone errors", () => {
    expect(classifyDockerExecOutput("Cannot connect to the Docker daemon. Is the docker daemon running?")).toBe(
      "daemon",
    );
    expect(classifyDockerExecOutput("error during connect: open //./pipe/docker_engine")).toBe("daemon");
    expect(classifyDockerExecOutput("permission denied while trying to connect to the Docker daemon socket")).toBe(
      "permission",
    );
    expect(classifyDockerExecOutput("Error response from daemon: Container web is not running")).toBe("not-running");
    expect(classifyDockerExecOutput("Error: No such container: web")).toBe("not-running");
    expect(classifyDockerExecOutput('exec: "/bin/sh": stat /bin/sh: no such file')).toBe("missing-shell");
    expect(classifyDockerExecOutput("")).toBe("unknown");
  });
});

describe("classifyPtyExec", () => {
  it("retries only on missing-shell output, not every immediate exit", () => {
    expect(classifyPtyExec("exited", 'exec: "/bin/sh": no such file')).toBe("missing-shell");
    expect(classifyPtyExec("quiet", 'exec: "/bin/sh": no such file')).toBe("missing-shell");
    expect(classifyPtyExec("timeout", 'exec: "/bin/sh": no such file')).toBe("missing-shell");
    expect(classifyPtyExec("exited", "Cannot connect to the Docker daemon")).toBe("exec-fail");
    expect(classifyPtyExec("quiet", "Cannot connect to the Docker daemon")).toBe("exec-fail");
    expect(classifyPtyExec("timeout", "permission denied while trying to connect")).toBe("exec-fail");
    expect(classifyPtyExec("quiet", "Error response from daemon: Container web is not running")).toBe("exec-fail");
    expect(classifyPtyExec("exited", "")).toBe("exec-fail");
    expect(classifyPtyExec("quiet", "$ ")).toBe("ok");
    expect(classifyPtyExec("timeout", "")).toBe("ok");
    expect(classifyPtyExec("timeout", "Welcome\n$ ")).toBe("ok");
  });
});

describe("executeDockerLaunch", () => {
  it("fails before any IO when the container name is empty", async () => {
    const { deps, spawned, ensured } = createDeps();
    const outcome = await executeDockerLaunch({ ...baseInput, container: "  " }, deps);
    expect(outcome).toEqual({ ok: false, reason: "empty-container", detail: "未指定容器" });
    expect(dockerLaunchNotice(outcome)).toBe("Docker 启动失败：未指定容器");
    expect(dockerLaunchStatus(outcome)).toBe("error");
    expect(ensured).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it("kills the previous session, ensures the container, then execs sh", async () => {
    const { deps, spawned, ensured, killed, written } = createDeps();
    const outcome = await executeDockerLaunch({ ...baseInput, killFirst: true }, deps);
    expect(outcome).toEqual({ ok: true });
    expect(killed).toEqual([baseInput.sessionId]);
    expect(ensured).toEqual(["web"]);
    expect(spawned).toEqual([dockerExecOpts(baseInput, "/bin/sh")]);
    expect(written).toEqual(["cd /workspace\n"]);
  });

  it("retries bash when sh is a missing interpreter", async () => {
    let probes = 0;
    const { deps, spawned, cleared, written } = createDeps({
      waitQuiet: () => {
        probes += 1;
        return waitHandle(
          probes === 1
            ? { status: "exited", output: 'exec: "/bin/sh": no such file' }
            : { status: "quiet", output: "$ " },
        );
      },
    });
    const outcome = await executeDockerLaunch(baseInput, deps);
    expect(outcome).toEqual({ ok: true });
    expect(spawned.map((opts) => opts.args?.[opts.args.length - 1])).toEqual(["/bin/sh", "/bin/bash"]);
    expect(cleared).toEqual([baseInput.sessionId]);
    expect(written).toEqual(["cd /workspace\n"]);
  });

  it("does not kill a silent sh on probe timeout, and still injects", async () => {
    const { deps, spawned, cleared, written } = createDeps({
      waitQuiet: () => waitHandle({ status: "timeout", output: "" }),
    });
    const outcome = await executeDockerLaunch(baseInput, deps);
    expect(outcome).toEqual({ ok: true });
    expect(spawned).toHaveLength(1);
    expect(cleared).toEqual([]);
    expect(written).toEqual(["cd /workspace\n"]);
  });

  it("does not retry bash when exec exits for a non-shell reason", async () => {
    const output = "Cannot connect to the Docker daemon. Is the docker daemon running?";
    const { deps, spawned, written, cleared } = createDeps({
      waitQuiet: () => waitHandle({ status: "exited", output }),
    });
    const outcome = await executeDockerLaunch(baseInput, deps);
    expect(outcome).toEqual({ ok: false, reason: "exec", detail: dockerExecFailDetail(output) });
    expect(dockerLaunchNotice(outcome)).toBe(`Docker 启动失败：${output}`);
    expect(dockerLaunchStatus(outcome)).toBe("error");
    expect(spawned).toHaveLength(1);
    expect(cleared).toEqual([]);
    expect(written).toEqual([]);
  });

  it("treats daemon output as exec failure even before pty-exit", async () => {
    const output = "Cannot connect to the Docker daemon. Is the docker daemon running?";
    const { deps, spawned, written, cleared } = createDeps({
      waitQuiet: () => waitHandle({ status: "quiet", output }),
    });
    const outcome = await executeDockerLaunch(baseInput, deps);
    expect(outcome).toEqual({ ok: false, reason: "exec", detail: dockerExecFailDetail(output) });
    expect(dockerLaunchStatus(outcome)).toBe("error");
    expect(spawned).toHaveLength(1);
    expect(cleared).toEqual([baseInput.sessionId]);
    expect(written).toEqual([]);
  });

  it("reports a generic immediate exit without claiming the shell is missing", async () => {
    const { deps, spawned, written } = createDeps({
      waitQuiet: () => waitHandle({ status: "exited", output: "" }),
    });
    const outcome = await executeDockerLaunch(baseInput, deps);
    expect(outcome).toEqual({ ok: false, reason: "exec", detail: "docker exec 立即退出" });
    expect(spawned).toHaveLength(1);
    expect(written).toEqual([]);
  });

  it("falls back through every shell before reporting no-shell", async () => {
    const { deps, spawned, written } = createDeps({
      waitQuiet: () => waitHandle({ status: "exited", output: "executable file not found in $PATH" }),
    });
    const outcome = await executeDockerLaunch(baseInput, deps);
    expect(outcome).toEqual({ ok: false, reason: "no-shell", detail: "容器内找不到可用 shell" });
    expect(spawned).toHaveLength(2);
    expect(written).toEqual([]);
  });

  it("skips inject and fallback when the PTY is reused", async () => {
    const { deps, spawned, written, cleared } = createDeps({
      spawn: async (opts) => {
        spawned.push(opts);
        return spawnResult(1, true);
      },
    });
    const outcome = await executeDockerLaunch(baseInput, deps);
    expect(outcome).toEqual({ ok: true });
    expect(spawned).toHaveLength(1);
    expect(written).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it("treats a reused fallback spawn as no-shell", async () => {
    const spawned: SpawnOpts[] = [];
    const { deps } = createDeps({
      spawn: async (opts) => {
        spawned.push(opts);
        return spawnResult(spawned.length, spawned.length > 1);
      },
      waitQuiet: () => waitHandle({ status: "exited", output: 'exec: "/bin/sh": no such file' }),
    });
    const outcome = await executeDockerLaunch(baseInput, deps);
    expect(outcome).toEqual({ ok: false, reason: "no-shell", detail: "无法切换到备用 shell" });
    expect(spawned).toHaveLength(2);
  });

  it("tries bash when the first spawn throws", async () => {
    const spawned: SpawnOpts[] = [];
    const { deps, written } = createDeps({
      spawn: async (opts) => {
        spawned.push(opts);
        if (spawned.length === 1) throw new Error("spawn failed");
        return spawnResult(2);
      },
    });
    const outcome = await executeDockerLaunch(baseInput, deps);
    expect(outcome).toEqual({ ok: true });
    expect(spawned.map((opts) => opts.args?.[opts.args.length - 1])).toEqual(["/bin/sh", "/bin/bash"]);
    expect(written).toEqual(["cd /workspace\n"]);
  });

  it("maps ensure failure without spawning", async () => {
    const { deps, spawned } = createDeps({
      ensureRunning: async () => {
        throw new Error("找不到容器 web");
      },
    });
    const outcome = await executeDockerLaunch(baseInput, deps);
    expect(outcome).toEqual({ ok: false, reason: "ensure", detail: "Error: 找不到容器 web" });
    expect(spawned).toEqual([]);
    expect(dockerLaunchNotice(outcome)).toBe("Docker 启动失败：Error: 找不到容器 web");
  });

  it("keeps the session usable when inject write fails", async () => {
    const { deps, spawned } = createDeps({
      write: async () => {
        throw new Error("write failed");
      },
    });
    const outcome = await executeDockerLaunch(baseInput, deps);
    expect(outcome).toEqual({
      ok: false,
      reason: "inject",
      detail: "Error: write failed",
      sessionAlive: true,
    });
    expect(dockerLaunchStatus(outcome)).toBe("running");
    expect(dockerLaunchNotice(outcome)).toBe("未能执行自动命令：Error: write failed");
    expect(spawned).toHaveLength(1);
  });

  it("marks inject failure as dead when the session is gone", async () => {
    const { deps } = createDeps({
      write: async () => {
        throw new Error("终端会话不存在");
      },
      sessionExists: async () => false,
    });
    const outcome = await executeDockerLaunch(baseInput, deps);
    expect(outcome).toEqual({
      ok: false,
      reason: "inject",
      detail: "Error: 终端会话不存在",
      sessionAlive: false,
    });
    expect(dockerLaunchStatus(outcome)).toBe("error");
  });

  it("does not spawn after the launch is aborted during ensure", async () => {
    const abort = new AbortController();
    const { deps, spawned, written } = createDeps({
      ensureRunning: async () => {
        abort.abort();
      },
    });
    const outcome = await executeDockerLaunch({ ...baseInput, signal: abort.signal }, deps);
    expect(outcome).toEqual({ ok: false, reason: "cancelled", detail: "已取消" });
    expect(dockerLaunchNotice(outcome)).toBeNull();
    expect(dockerLaunchStatus(outcome)).toBe("idle");
    expect(spawned).toEqual([]);
    expect(written).toEqual([]);
  });
});
