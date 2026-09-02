import { describe, expect, it } from "vitest";
import type { AgentPreset, Project, WorkspacePane } from "../types";
import { agentPanesToRestart, planPaneLaunch } from "./paneLaunch";

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

function pane(partial: Partial<WorkspacePane> & Pick<WorkspacePane, "id" | "kind">): WorkspacePane {
  return partial;
}

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

const agentPane = pane({
  id: "a1",
  kind: "agent",
  preset_id: "cursor",
  agent_session_id: "chat-9",
});
const runnerPane = pane({ id: "r1", kind: "runner" });
const explorerPane = pane({ id: "e1", kind: "explorer" });

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
    expect(ensure?.action).toBe("skip");
    expect(ensure?.spawn).toBeNull();

    const restart = planPaneLaunch({ ...base, mode: "restart" });
    expect(restart?.action).toBe("spawn");
    expect(restart?.killFirst).toBe(true);
    expect(restart?.spawn?.args).toEqual(["--resume", "chat-9"]);
  });

  it("spawns a runner with an empty command and no fallback", () => {
    const plan = planPaneLaunch({
      mode: "ensure",
      project: project({ panes: [runnerPane] }),
      pane: runnerPane,
      presets: [cursor],
      resumeOnStart: true,
      status: "idle",
      agentSeen: false,
    });
    expect(plan).toMatchObject({
      action: "spawn",
      killFirst: false,
      spawn: { sessionId: "proj:runner:r1", cwd: "C:\\work", command: "" },
      fallbackSpawn: null,
      markAgentSeen: false,
      failNoticePrefix: "Runner",
    });
  });

  it("resumes an agent and falls back to a bare spawn that clears the session id", () => {
    const plan = planPaneLaunch({
      mode: "ensure",
      project: project({ panes: [agentPane], agent_seen: false }),
      pane: agentPane,
      presets: [cursor],
      resumeOnStart: true,
      status: "exited",
      agentSeen: false,
    });
    expect(plan?.spawn?.args).toEqual(["--resume", "chat-9"]);
    expect(plan?.fallbackSpawn?.args).toEqual([]);
    expect(plan?.clearSessionOnFallback).toBe(true);
    expect(plan?.markAgentSeen).toBe(true);
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
    expect(plan?.spawn?.args).toEqual([]);
    expect(plan?.fallbackSpawn).toBeNull();
    expect(plan?.markAgentSeen).toBe(false);
  });

  it("uses --session for opencode and no resume flags for unknown binaries", () => {
    const ocPane = pane({ id: "a2", kind: "agent", preset_id: "oc", agent_session_id: "s1" });
    const ocPlan = planPaneLaunch({
      mode: "ensure",
      project: project({ panes: [ocPane], agent_preset: "oc" }),
      pane: ocPane,
      presets: [oc],
      resumeOnStart: true,
      status: "idle",
      agentSeen: true,
    });
    expect(ocPlan?.spawn?.args).toEqual(["--session", "s1"]);

    const unknown: AgentPreset = { id: "x", name: "X", command: "mystery", drag_prefix: "@" };
    const xPane = pane({ id: "a3", kind: "agent", preset_id: "x", agent_session_id: "s1" });
    const xPlan = planPaneLaunch({
      mode: "ensure",
      project: project({ panes: [xPane] }),
      pane: xPane,
      presets: [unknown],
      resumeOnStart: true,
      status: "idle",
      agentSeen: true,
    });
    expect(xPlan?.spawn?.args).toEqual([]);
    expect(xPlan?.fallbackSpawn).toBeNull();
  });
});

describe("agentPanesToRestart", () => {
  const agentA = pane({ id: "a1", kind: "agent", preset_id: "cursor" });
  const agentB = pane({ id: "a2", kind: "agent", preset_id: "oc" });
  const runner = pane({ id: "r1", kind: "runner" });
  const open = project({ id: "open", panes: [agentA, agentB, runner] });
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

  it("restarts every opened agent pane on theme change", () => {
    const refs = agentPanesToRestart(["open"], [open, closed], { kind: "theme" });
    expect(refs).toEqual([
      { projectId: "open", paneId: "a1" },
      { projectId: "open", paneId: "a2" },
    ]);
  });
});
