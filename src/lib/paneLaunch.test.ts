import { describe, expect, it } from "vitest";
import type { AgentPreset, Project, WorkspacePane } from "../types";
import { agentPanesToRestart, planPaneLaunch, planProjectLaunches } from "./paneLaunch";
import { DEFAULT_DOCKER_SHELLS } from "./dockerLaunch";
import { commandPayload } from "./quickCommands";

const cursor: AgentPreset = {
  id: "cursor",
  name: "Cursor",
  command: "cursor-agent",
  drag_prefix: "@",
};
const oc: AgentPreset = {
  id: "oc",
  name: "OpenCode",
  command: "opencode",
  drag_prefix: "@",
};
const dsh: AgentPreset = {
  id: "dsh-tui",
  name: "dsh-tui",
  command: "dsh-tui",
  drag_prefix: "@",
};

function project(partial: Partial<Project> = {}): Project {
  return {
    id: "proj",
    name: "demo",
    path: "C:\\work",
    agent_preset: "cursor",
    agent_seen: true,
    agent_session_id: null,
    layout: "row",
    active_pane_id: "a1",
    panes: [],
    ...partial,
  };
}

const agentPane: WorkspacePane = {
  id: "a1",
  kind: "agent",
  preset_id: "cursor",
  agent_session_id: "chat-9",
};
const runnerPane: WorkspacePane = { id: "r1", kind: "runner" };
const explorerPane: WorkspacePane = { id: "e1", kind: "explorer" };
const dockerPane: WorkspacePane = {
  id: "d1",
  kind: "docker",
  docker_container: "web",
  docker_auto_exec: true,
  docker_exec_command: "cd /workspace\ncursor-agent",
};

describe("planPaneLaunch", () => {
  it("returns null for explorer panes", () => {
    expect(
      planPaneLaunch({
        mode: "ensure",
        project: project({ panes: [explorerPane] }),
        pane: explorerPane,
        presets: [cursor],
        resumeOnStart: true,
        status: "idle",
        agentSeen: true,
      }),
    ).toBeNull();
  });

  it("skips a live pane on ensure, but restarts it", () => {
    const base = {
      project: project({ panes: [agentPane] }),
      pane: agentPane,
      presets: [cursor],
      resumeOnStart: true,
      status: "waiting" as const,
      agentSeen: true,
    };
    const ensure = planPaneLaunch({ ...base, mode: "ensure" });
    expect(ensure).toEqual({ action: "skip", sessionId: "proj:agent:a1" });

    const restart = planPaneLaunch({ ...base, mode: "restart" });
    expect(restart?.action).toBe("spawn");
    expect(restart && restart.action === "spawn" ? restart.killFirst : false).toBe(true);
    expect(restart && restart.action === "spawn" && restart.kind === "agent" ? restart.spawn.args : null).toEqual([
      "--resume",
      "chat-9",
    ]);
  });

  it("spawns a runner with an empty command and no resume fallback", () => {
    const plan = planPaneLaunch({
      mode: "ensure",
      project: project({ panes: [runnerPane] }),
      pane: runnerPane,
      presets: [cursor],
      resumeOnStart: true,
      status: "idle",
      agentSeen: false,
    });
    expect(plan).toEqual({
      action: "spawn",
      kind: "runner",
      sessionId: "proj:runner:r1",
      killFirst: false,
      spawn: { sessionId: "proj:runner:r1", cwd: "C:\\work", command: "" },
    });
  });

  it("resumes cursor-agent without a bare-spawn fallback", () => {
    const plan = planPaneLaunch({
      mode: "ensure",
      project: project({ panes: [agentPane], agent_seen: false }),
      pane: agentPane,
      presets: [cursor],
      resumeOnStart: true,
      status: "exited",
      agentSeen: false,
    });
    expect(plan?.action).toBe("spawn");
    if (plan?.action !== "spawn" || plan.kind !== "agent") throw new Error("expected agent spawn");
    expect(plan.spawn.args).toEqual(["--resume", "chat-9"]);
    expect(plan.resumeFallback).toBeNull();
    expect(plan.markAgentSeen).toBe(true);
  });

  it("resumes dsh-tui and falls back to a bare spawn that clears the session id", () => {
    const dshPane: WorkspacePane = {
      id: "a1",
      kind: "agent",
      preset_id: "dsh-tui",
      agent_session_id: "chat-9",
    };
    const plan = planPaneLaunch({
      mode: "ensure",
      project: project({ panes: [dshPane], agent_preset: "dsh-tui", agent_seen: false }),
      pane: dshPane,
      presets: [dsh],
      resumeOnStart: true,
      status: "exited",
      agentSeen: false,
    });
    expect(plan?.action).toBe("spawn");
    if (plan?.action !== "spawn" || plan.kind !== "agent") throw new Error("expected agent spawn");
    expect(plan.spawn.args).toEqual(["--resume", "chat-9"]);
    expect(plan.resumeFallback?.args).toEqual([]);
    expect(plan.markAgentSeen).toBe(true);
  });

  it("does not resume when resume-on-start is off", () => {
    const plan = planPaneLaunch({
      mode: "restart",
      project: project({ panes: [agentPane] }),
      pane: agentPane,
      presets: [cursor],
      resumeOnStart: false,
      status: "running",
      agentSeen: false,
    });
    if (plan?.action !== "spawn" || plan.kind !== "agent") throw new Error("expected agent spawn");
    expect(plan.spawn.args).toEqual([]);
    expect(plan.resumeFallback).toBeNull();
    expect(plan.markAgentSeen).toBe(false);
  });

  it("uses --session for opencode and no resume flags for unknown binaries", () => {
    const ocPane: WorkspacePane = { id: "a2", kind: "agent", preset_id: "oc", agent_session_id: "s1" };
    const ocPlan = planPaneLaunch({
      mode: "ensure",
      project: project({ panes: [ocPane], agent_preset: "oc" }),
      pane: ocPane,
      presets: [oc],
      resumeOnStart: true,
      status: "idle",
      agentSeen: true,
    });
    if (ocPlan?.action !== "spawn" || ocPlan.kind !== "agent") throw new Error("expected agent spawn");
    expect(ocPlan.spawn.args).toEqual(["--session", "s1"]);

    const unknown: AgentPreset = { id: "x", name: "X", command: "mystery", drag_prefix: "@" };
    const xPane: WorkspacePane = { id: "a3", kind: "agent", preset_id: "x", agent_session_id: "s1" };
    const xPlan = planPaneLaunch({
      mode: "ensure",
      project: project({ panes: [xPane] }),
      pane: xPane,
      presets: [unknown],
      resumeOnStart: true,
      status: "idle",
      agentSeen: true,
    });
    if (xPlan?.action !== "spawn" || xPlan.kind !== "agent") throw new Error("expected agent spawn");
    expect(xPlan.spawn.args).toEqual([]);
    expect(xPlan.resumeFallback).toBeNull();
  });

  it("plans docker exec with shell list and auto-exec payload, not spawn flags", () => {
    const plan = planPaneLaunch({
      mode: "ensure",
      project: project({ panes: [dockerPane] }),
      pane: dockerPane,
      presets: [cursor],
      resumeOnStart: true,
      status: "idle",
      agentSeen: true,
    });
    expect(plan).toEqual({
      action: "spawn",
      kind: "docker",
      sessionId: "proj:docker:d1",
      killFirst: false,
      input: {
        sessionId: "proj:docker:d1",
        cwd: "C:\\work",
        container: "web",
        shells: DEFAULT_DOCKER_SHELLS,
        postWrite: commandPayload("cd /workspace\ncursor-agent"),
        killFirst: false,
      },
    });
  });

  it("keeps an empty docker container on the docker plan for launch to reject", () => {
    const empty: WorkspacePane = { id: "d0", kind: "docker", docker_container: "  " };
    const plan = planPaneLaunch({
      mode: "ensure",
      project: project({ panes: [empty] }),
      pane: empty,
      presets: [cursor],
      resumeOnStart: true,
      status: "idle",
      agentSeen: true,
    });
    if (plan?.action !== "spawn" || plan.kind !== "docker") throw new Error("expected docker spawn");
    expect(plan.input.container).toBe("");
    expect(plan.input.shells).toEqual(DEFAULT_DOCKER_SHELLS);
  });

  it("skips a live docker pane and omits postWrite when auto-exec is off", () => {
    const live = planPaneLaunch({
      mode: "ensure",
      project: project({ panes: [dockerPane] }),
      pane: dockerPane,
      presets: [cursor],
      resumeOnStart: true,
      status: "running",
      agentSeen: true,
    });
    expect(live).toEqual({ action: "skip", sessionId: "proj:docker:d1" });

    const quiet: WorkspacePane = {
      id: "d2",
      kind: "docker",
      docker_container: "db",
      docker_auto_exec: false,
      docker_exec_command: "ls",
    };
    const plan = planPaneLaunch({
      mode: "restart",
      project: project({ panes: [quiet] }),
      pane: quiet,
      presets: [cursor],
      resumeOnStart: false,
      status: "exited",
      agentSeen: true,
    });
    if (plan?.action !== "spawn" || plan.kind !== "docker") throw new Error("expected docker spawn");
    expect(plan.killFirst).toBe(true);
    expect(plan.input.container).toBe("db");
    expect(plan.input.postWrite).toBeNull();
    expect(plan.input.killFirst).toBe(true);
  });
});

describe("planProjectLaunches", () => {
  it("plans one entry per terminal pane and skips explorer panes", () => {
    const launches = planProjectLaunches({
      project: project({ panes: [explorerPane, agentPane, runnerPane] }),
      presets: [cursor],
      resumeOnStart: true,
      statusOf: () => "idle",
    });
    expect(launches.map((item) => item.paneId)).toEqual(["a1", "r1"]);
    expect(launches[0].plan.kind).toBe("agent");
    expect(launches[1].plan.kind).toBe("runner");
  });

  it("asks the caller for each pane's status by its session id", () => {
    const asked: string[] = [];
    planProjectLaunches({
      project: project({ panes: [agentPane, runnerPane] }),
      presets: [cursor],
      resumeOnStart: true,
      statusOf: (sid) => {
        asked.push(sid);
        return "idle";
      },
    });
    expect(asked).toEqual(["proj:agent:a1", "proj:runner:r1"]);
  });

  it("skips live panes so ensure does not respawn them", () => {
    const launches = planProjectLaunches({
      project: project({ panes: [agentPane, runnerPane] }),
      presets: [cursor],
      resumeOnStart: true,
      statusOf: (sid) => (sid === "proj:agent:a1" ? "running" : "idle"),
    });
    expect(launches.map((item) => item.paneId)).toEqual(["r1"]);
  });

  it("returns nothing when every pane is already live", () => {
    expect(
      planProjectLaunches({
        project: project({ panes: [agentPane, runnerPane] }),
        presets: [cursor],
        resumeOnStart: true,
        statusOf: () => "waiting",
      }),
    ).toEqual([]);
  });

  it("resumes a stored agent session only when resume-on-start is on", () => {
    const base = {
      project: project({ panes: [agentPane] }),
      presets: [cursor],
      statusOf: () => "exited" as const,
    };
    const on = planProjectLaunches({ ...base, resumeOnStart: true });
    if (on[0].plan.kind !== "agent") throw new Error("expected agent plan");
    expect(on[0].plan.spawn.args).toEqual(["--resume", "chat-9"]);

    const off = planProjectLaunches({ ...base, resumeOnStart: false });
    if (off[0].plan.kind !== "agent") throw new Error("expected agent plan");
    expect(off[0].plan.spawn.args).toEqual([]);
  });

  it("carries the project's agent_seen flag into the agent plan", () => {
    const unseen = planProjectLaunches({
      project: project({ panes: [agentPane], agent_seen: false }),
      presets: [cursor],
      resumeOnStart: true,
      statusOf: () => "exited",
    });
    if (unseen[0].plan.kind !== "agent") throw new Error("expected agent plan");
    expect(unseen[0].plan.markAgentSeen).toBe(true);

    const seen = planProjectLaunches({
      project: project({ panes: [agentPane], agent_seen: true }),
      presets: [cursor],
      resumeOnStart: true,
      statusOf: () => "exited",
    });
    if (seen[0].plan.kind !== "agent") throw new Error("expected agent plan");
    expect(seen[0].plan.markAgentSeen).toBe(false);
  });
});

describe("agentPanesToRestart", () => {
  const agentA: WorkspacePane = { id: "a1", kind: "agent", preset_id: "cursor" };
  const agentB: WorkspacePane = { id: "a2", kind: "agent", preset_id: "oc" };
  const runner: WorkspacePane = { id: "r1", kind: "runner" };
  const open = project({
    id: "open",
    panes: [agentA, agentB, runner, explorerPane, dockerPane],
  });
  const closed = project({ id: "closed", panes: [agentA] });

  it("restarts only opened agent panes whose resolved command changed", () => {
    const nextCursor: AgentPreset = { ...cursor, command: "cursor-agent --force" };
    const refs = agentPanesToRestart(["open"], [open, closed], {
      kind: "preset-commands",
      prevPresets: [cursor, oc],
      nextPresets: [nextCursor, oc],
    });
    expect(refs).toEqual([{ projectId: "open", paneId: "a1" }]);
  });

  it("restarts every opened agent and runner pane on theme change", () => {
    const refs = agentPanesToRestart(["open"], [open, closed], { kind: "theme" });
    expect(refs).toEqual([
      { projectId: "open", paneId: "a1" },
      { projectId: "open", paneId: "a2" },
      { projectId: "open", paneId: "r1" },
    ]);
  });
});
