import { describe, expect, it } from "vitest";
import { ensureOpened } from "./projects";
import { projectSessionIds } from "./panes";
import type { Project, WorkspacePane } from "../types";

describe("project open / close helpers", () => {
  it("appends an id only once", () => {
    expect(ensureOpened(["a"], "b")).toEqual(["a", "b"]);
    expect(ensureOpened(["a", "b"], "a")).toEqual(["a", "b"]);
  });

  it("collects terminal session ids and ignores explorer panes", () => {
    const panes: WorkspacePane[] = [
      { id: "e1", kind: "explorer" },
      { id: "a1", kind: "agent" },
      { id: "r1", kind: "runner" },
      { id: "d1", kind: "docker", docker_container: "web" },
    ];
    const project: Project = {
      id: "p",
      name: "p",
      path: "C:\\p",
      agent_preset: "cursor",
      agent_seen: true,
      agent_session_id: null,
      layout: "row",
      active_pane_id: "e1",
      panes,
    };
    expect(projectSessionIds("p", project)).toEqual(["p:agent:a1", "p:runner:r1", "p:docker:d1"]);
    expect(projectSessionIds("p", undefined)).toEqual([]);
  });
});
