import { describe, expect, it } from "vitest";
import type { AppConfig, Project, WorkspacePane } from "../types";
import { applySessionAssignments } from "./agentSessionApply";

function config(projects: Project[] = []): AppConfig {
  return {
    settings: { theme: "dark", default_split_ratio: [30, 40, 30], active_project_id: null, explorer_view: "list", resume_on_start: true, terminal_font: "" },
    agent_presets: [],
    bookmarks: [],
    projects,
  };
}

function agentPane(paneId: string, sessionId?: string | null): WorkspacePane {
  return { id: paneId, kind: "agent", agent_session_id: sessionId ?? null };
}

function runnerPane(paneId: string): WorkspacePane {
  return { id: paneId, kind: "runner" };
}

function project(id: string, panes: WorkspacePane[]): Project {
  return {
    id,
    name: id,
    path: `C:\\${id}`,
    agent_preset: "p1",
    agent_seen: false,
    agent_session_id: null,
    layout: "row",
    active_pane_id: null,
    panes,
  };
}

describe("applySessionAssignments", () => {
  it("returns null for an empty assignment list", () => {
    const cfg = config([project("p", [agentPane("a")])]);
    expect(applySessionAssignments(cfg, [])).toBeNull();
  });

  it("returns null when nothing actually changes", () => {
    const cfg = config([project("p", [agentPane("a", "chat-1")])]);
    expect(
      applySessionAssignments(cfg, [{ projectId: "p", paneId: "a", sessionId: "chat-1" }]),
    ).toBeNull();
  });

  it("assigns a chat id to an empty agent pane", () => {
    const cfg = config([project("p", [agentPane("a")])]);
    const next = applySessionAssignments(cfg, [
      { projectId: "p", paneId: "a", sessionId: "chat-1" },
    ]);
    expect(next?.projects[0].panes[0]).toMatchObject({ kind: "agent", agent_session_id: "chat-1" });
  });

  it("clears an agent pane session id when assignment is null", () => {
    const cfg = config([project("p", [agentPane("a", "chat-1")])]);
    const next = applySessionAssignments(cfg, [{ projectId: "p", paneId: "a", sessionId: null }]);
    expect(next?.projects[0].panes[0]).toMatchObject({ kind: "agent", agent_session_id: null });
  });

  it("does not touch non-agent panes even when the pane id matches", () => {
    const panes = [runnerPane("a")];
    const cfg = config([project("p", panes)]);
    const next = applySessionAssignments(cfg, [
      { projectId: "p", paneId: "a", sessionId: "chat-1" },
    ]);
    expect(next).toBeNull();
  });

  it("only rewrites the project that has an update, leaving others untouched", () => {
    const cfg = config([project("p1", [agentPane("a")]), project("p2", [agentPane("b", "chat-b")])]);
    const next = applySessionAssignments(cfg, [
      { projectId: "p1", paneId: "a", sessionId: "chat-a" },
    ]);
    expect(next?.projects[0].panes[0]).toMatchObject({ agent_session_id: "chat-a" });
    // p2 keeps its stored id and its object identity (untouched)
    expect(next?.projects[1]).toBe(cfg.projects[1]);
  });

  it("returns a new config object but reuses untouched project objects", () => {
    const untouched = project("p2", [agentPane("b")]);
    const cfg = config([project("p1", [agentPane("a")]), untouched]);
    const next = applySessionAssignments(cfg, [
      { projectId: "p1", paneId: "a", sessionId: "chat-a" },
    ]);
    expect(next).not.toBe(cfg);
    expect(next?.projects[1]).toBe(untouched);
  });
});
