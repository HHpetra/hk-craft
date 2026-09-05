import { describe, expect, it } from "vitest";
import { assignmentFromOpencodeHook } from "./opencodeHook";
import type { AppConfig, Project, WorkspacePane } from "../types";

const agent: WorkspacePane = { id: "a1", kind: "agent", preset_id: "oc", agent_session_id: null };
const runner: WorkspacePane = { id: "r1", kind: "runner" };

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
    panes: [agent, runner],
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

describe("assignmentFromOpencodeHook", () => {
  it("binds a reported id onto an open agent pane", () => {
    expect(
      assignmentFromOpencodeHook(
        { session_id: "proj:agent:a1", opencode_id: "ses_abc" },
        config([project()]),
      ),
    ).toEqual({ projectId: "proj", paneId: "a1", sessionId: "ses_abc" });
  });

  it("ignores non-agent sessions, closed panes, and unchanged ids", () => {
    const open = config([project()]);
    expect(
      assignmentFromOpencodeHook({ session_id: "proj:runner:r1", opencode_id: "ses_abc" }, open),
    ).toBeNull();
    expect(
      assignmentFromOpencodeHook({ session_id: "proj:agent:gone", opencode_id: "ses_abc" }, open),
    ).toBeNull();
    expect(
      assignmentFromOpencodeHook(
        { session_id: "proj:agent:a1", opencode_id: "ses_abc" },
        config([project({ panes: [{ ...agent, agent_session_id: "ses_abc" }, runner] })]),
      ),
    ).toBeNull();
    expect(
      assignmentFromOpencodeHook({ session_id: "proj:agent:a1", opencode_id: "ses_abc" }, null),
    ).toBeNull();
    expect(
      assignmentFromOpencodeHook({ session_id: "proj:agent:a1", opencode_id: "msg_abc" }, open),
    ).toBeNull();
  });
});
