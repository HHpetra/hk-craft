import { describe, expect, it } from "vitest";
import { activeRunningSessions } from "./panes";
import type { AppConfig, Project, SessionStatus, WorkspacePane } from "../types";

const explorer: WorkspacePane = { id: "e1", kind: "explorer" };
const agent: WorkspacePane = { id: "a1", kind: "agent", preset_id: "oc", agent_session_id: null };
const runner: WorkspacePane = { id: "r1", kind: "runner" };
const docker: WorkspacePane = { id: "d1", kind: "docker", docker_container: "dev" };

function project(partial: Partial<Project> = {}): Project {
  return {
    id: "proj",
    name: "demo",
    path: "C:\\work",
    agent_preset: "oc",
    agent_seen: true,
    agent_session_id: null,
    layout: "row",
    active_pane_id: "a1",
    panes: [explorer, agent, runner, docker],
    ...partial,
  };
}

function config(projects: Project[]): AppConfig {
  return {
    settings: {
      theme: "dark",
      default_split_ratio: [1],
      active_project_id: "proj",
      explorer_view: "list",
      resume_on_start: true,
      terminal_font: "",
    },
    agent_presets: [],
    bookmarks: [],
    projects,
  };
}

function sessions(map: Record<string, SessionStatus>) {
  return activeRunningSessions({
    config: config([project()]),
    openedProjectIds: ["proj"],
    sessionStatus: map,
  });
}

describe("activeRunningSessions", () => {
  it("returns empty when nothing is running", () => {
    expect(sessions({})).toEqual([]);
    expect(
      activeRunningSessions({
        config: null,
        openedProjectIds: ["proj"],
        sessionStatus: { "proj:agent:a1": "running" },
      }),
    ).toEqual([]);
  });

  it("counts running and waiting terminal panes", () => {
    expect(sessions({ "proj:agent:a1": "running" })).toEqual([{ projectName: "demo", kind: "agent" }]);
    expect(sessions({ "proj:runner:r1": "waiting" })).toEqual([{ projectName: "demo", kind: "runner" }]);
    expect(
      sessions({
        "proj:agent:a1": "running",
        "proj:docker:d1": "waiting",
      }),
    ).toEqual([
      { projectName: "demo", kind: "agent" },
      { projectName: "demo", kind: "docker" },
    ]);
  });

  it("ignores idle, exited, and error", () => {
    expect(
      sessions({
        "proj:agent:a1": "idle",
        "proj:runner:r1": "exited",
        "proj:docker:d1": "error",
      }),
    ).toEqual([]);
  });

  it("ignores closed projects and explorer panes", () => {
    expect(
      activeRunningSessions({
        config: config([project()]),
        openedProjectIds: [],
        sessionStatus: { "proj:agent:a1": "running" },
      }),
    ).toEqual([]);
    expect(
      sessions({
        "proj:explorer:e1": "running",
        "proj:agent:a1": "idle",
      }),
    ).toEqual([]);
  });
});
