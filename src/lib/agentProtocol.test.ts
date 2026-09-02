import { describe, expect, it } from "vitest";
import type { AgentPreset, Project, WorkspacePane } from "../types";
import {
  agentBin,
  liveAgentTargets,
  resolveAgentCommand,
  resumeArgsForSession,
} from "./agentProtocol";

const cursor: AgentPreset = {
  id: "cursor",
  name: "Cursor",
  command: "cursor-agent",
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

describe("agent protocol table", () => {
  it("strips paths and extensions from the binary name", () => {
    expect(agentBin(String.raw`C:\bin\cursor-agent.exe --foo`)).toBe("cursor-agent");
    expect(agentBin("opencode")).toBe("opencode");
  });

  it("uses --resume or --session from the shared table", () => {
    expect(resumeArgsForSession("cursor-agent", "abc")).toEqual(["--resume", "abc"]);
    expect(resumeArgsForSession("claude", "c1")).toEqual(["--resume", "c1"]);
    expect(resumeArgsForSession("dsh-tui", "sess")).toEqual(["--resume", "sess"]);
    expect(resumeArgsForSession("dst", "sess")).toEqual(["--resume", "sess"]);
    expect(resumeArgsForSession("opencode", "s1")).toEqual(["--session", "s1"]);
    expect(resumeArgsForSession("codex", "019d-abc")).toEqual(["resume", "019d-abc"]);
    expect(resumeArgsForSession(String.raw`C:\bin\codex.exe`, "s1")).toEqual(["resume", "s1"]);
    expect(resumeArgsForSession("mystery", "s1")).toEqual([]);
    expect(resumeArgsForSession("cursor-agent", "  ")).toEqual([]);
  });

  it("falls back to cursor-agent when a pane has no matching preset", () => {
    const pane: WorkspacePane = { id: "a1", kind: "agent", preset_id: "missing" };
    expect(resolveAgentCommand(pane, project(), [cursor])).toBe("cursor-agent");
  });

  it("lists only live agent panes in opened projects", () => {
    const agent: WorkspacePane = { id: "a1", kind: "agent", preset_id: "cursor" };
    const runner: WorkspacePane = { id: "r1", kind: "runner" };
    const open = project({ id: "open", panes: [agent, runner] });
    const closed = project({ id: "closed", panes: [agent] });
    const targets = liveAgentTargets(
      [open, closed],
      ["open"],
      { "open:agent:a1": "waiting", "closed:agent:a1": "running" },
      [cursor],
    );
    expect(targets).toEqual([
      { projectId: "open", paneId: "a1", command: "cursor-agent", cwd: "C:\\work" },
    ]);
  });
});
