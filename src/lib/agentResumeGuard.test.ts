import { describe, expect, it } from "vitest";
import type { AgentPreset, AppConfig, Project, WorkspacePane } from "../types";
import { applySessionAssignments } from "./agentSessionApply";
import { resumeCheckTargets } from "./agentResumeGuard";
import { planPaneLaunch } from "./paneLaunch";

const cursor: AgentPreset = {
  id: "cursor",
  name: "Cursor",
  command: "cursor-agent",
  drag_prefix: "@",
};
const dsh: AgentPreset = { id: "dsh-tui", name: "dsh-tui", command: "dsh-tui", drag_prefix: "@" };
const dst: AgentPreset = { id: "dst", name: "dst", command: "C:\\tools\\dst.exe", drag_prefix: "@" };

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

function config(projects: Project[], presets: AgentPreset[] = []): AppConfig {
  return {
    settings: {
      theme: "dark",
      default_split_ratio: [30, 40, 30],
      active_project_id: null,
      explorer_view: "list",
      resume_on_start: true,
      terminal_font: "",
    },
    agent_presets: presets,
    bookmarks: [],
    projects,
  };
}

const dshPane: WorkspacePane = {
  id: "a1",
  kind: "agent",
  preset_id: "dsh-tui",
  agent_session_id: "chat-1",
};

describe("resumeCheckTargets", () => {
  it("checks stored ids of agents that hard-exit on a missing resume log", () => {
    expect(resumeCheckTargets(project({ panes: [dshPane] }), [dsh])).toEqual([
      { paneId: "a1", command: "dsh-tui", sessionId: "chat-1" },
    ]);
  });

  it("matches the dst launcher and trims the stored id", () => {
    const pane: WorkspacePane = {
      id: "a2",
      kind: "agent",
      preset_id: "dst",
      agent_session_id: " chat-2 ",
    };
    expect(resumeCheckTargets(project({ panes: [pane] }), [dst])).toEqual([
      { paneId: "a2", command: "C:\\tools\\dst.exe", sessionId: "chat-2" },
    ]);
  });

  it("follows the project preset when the pane has none", () => {
    const pane: WorkspacePane = { id: "a3", kind: "agent", agent_session_id: "chat-3" };
    const targets = resumeCheckTargets(project({ panes: [pane], agent_preset: "dsh-tui" }), [dsh]);
    expect(targets).toEqual([{ paneId: "a3", command: "dsh-tui", sessionId: "chat-3" }]);
  });

  it("leaves tolerant agents, empty ids, and non-agent panes alone", () => {
    const panes: WorkspacePane[] = [
      { id: "c1", kind: "agent", preset_id: "cursor", agent_session_id: "chat-c" },
      { id: "d1", kind: "agent", preset_id: "dsh-tui" },
      { id: "d2", kind: "agent", preset_id: "dsh-tui", agent_session_id: "   " },
      { id: "r1", kind: "runner" },
      { id: "e1", kind: "explorer" },
    ];
    expect(resumeCheckTargets(project({ panes }), [cursor, dsh])).toEqual([]);
  });

  it("a cleared pane boots a fresh session instead of a fatal --resume", () => {
    const stale = project({ panes: [dshPane] });
    const targets = resumeCheckTargets(stale, [dsh]);
    // The backend reported the stored log is gone → the store clears the id.
    const cleared = applySessionAssignments(
      config([stale], [dsh]),
      targets.map((target) => ({
        projectId: stale.id,
        paneId: target.paneId,
        sessionId: null,
      })),
    );
    const clearedPane = cleared?.projects[0]?.panes[0];
    expect(clearedPane).toMatchObject({ id: "a1", agent_session_id: null });

    const plan = planPaneLaunch({
      mode: "ensure",
      project: cleared?.projects[0] ?? stale,
      pane: clearedPane ?? dshPane,
      presets: [dsh],
      resumeOnStart: true,
      status: undefined,
      agentSeen: true,
    });
    if (plan?.action !== "spawn" || plan.kind !== "agent") throw new Error("expected agent spawn");
    expect(plan.spawn.args).toEqual([]);
    expect(plan.resumeFallback).toBeNull();
  });
});
