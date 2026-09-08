import { describe, expect, it } from "vitest";
import type { AgentPreset, Project, PtySessionStat, WorkspacePane } from "../types";
import {
  OTHER_PROJECT_ID,
  OTHER_PROJECT_NAME,
  formatCpuPct,
  groupSessionStats,
  totalSessionStats,
} from "./sessionStats";

const explorer: WorkspacePane = { id: "e1", kind: "explorer" };
const agent: WorkspacePane = { id: "a1", kind: "agent", preset_id: "oc", agent_session_id: null };
const runner: WorkspacePane = { id: "r1", kind: "runner" };
const docker: WorkspacePane = { id: "d1", kind: "docker", docker_container: "dev" };

const presets: AgentPreset[] = [{ id: "oc", name: "OpenCode", command: "opencode", drag_prefix: "@" }];

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

function stat(partial: Partial<PtySessionStat> & Pick<PtySessionStat, "session_id">): PtySessionStat {
  return {
    pid: 100,
    memory_bytes: 1024,
    cpu_pct: 1,
    process_count: 1,
    ...partial,
  };
}

describe("groupSessionStats", () => {
  it("groups opened-project sessions and uses pane titles", () => {
    const groups = groupSessionStats(
      [
        stat({ session_id: "proj:agent:a1", memory_bytes: 200, cpu_pct: 2.5, process_count: 3 }),
        stat({ session_id: "proj:runner:r1", memory_bytes: 50, cpu_pct: 0.5, pid: 101 }),
      ],
      [project()],
      ["proj"],
      presets,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].projectName).toBe("demo");
    expect(groups[0].memoryBytes).toBe(250);
    expect(groups[0].cpuPct).toBe(3);
    expect(groups[0].rows.map((row) => row.title)).toEqual(["OpenCode", "运行终端"]);
  });

  it("moves closed-project and unknown sessions into 其他", () => {
    const closed = project({ id: "old", name: "archived" });
    const groups = groupSessionStats(
      [
        stat({ session_id: "old:agent:a1" }),
        stat({ session_id: "not-a-session" }),
      ],
      [project(), closed],
      ["proj"],
      presets,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].projectId).toBe(OTHER_PROJECT_ID);
    expect(groups[0].projectName).toBe(OTHER_PROJECT_NAME);
    expect(groups[0].rows).toHaveLength(2);
  });

  it("marks docker rows and keeps opened project order", () => {
    const other = project({ id: "two", name: "second", panes: [docker] });
    const groups = groupSessionStats(
      [
        stat({ session_id: "two:docker:d1" }),
        stat({ session_id: "proj:runner:r1" }),
      ],
      [project(), other],
      ["proj", "two"],
      presets,
    );
    expect(groups.map((group) => group.projectId)).toEqual(["proj", "two"]);
    expect(groups[1].rows[0].docker).toBe(true);
    expect(groups[1].rows[0].title).toBe("dev");
  });

  it("omits opened projects that have no live sessions", () => {
    const groups = groupSessionStats(
      [stat({ session_id: "proj:runner:r1" })],
      [project(), project({ id: "empty", name: "empty" })],
      ["empty", "proj"],
      presets,
    );
    expect(groups.map((group) => group.projectId)).toEqual(["proj"]);
  });
});

describe("totalSessionStats", () => {
  it("sums group subtotals", () => {
    const groups = groupSessionStats(
      [
        stat({ session_id: "proj:agent:a1", memory_bytes: 10, cpu_pct: 1.2, process_count: 2 }),
        stat({ session_id: "proj:docker:d1", memory_bytes: 5, cpu_pct: 0.3, process_count: 1, pid: 2 }),
      ],
      [project()],
      ["proj"],
      presets,
    );
    expect(totalSessionStats(groups)).toEqual({
      memoryBytes: 15,
      cpuPct: 1.5,
      processCount: 3,
      sessions: 2,
    });
  });
});

describe("formatCpuPct", () => {
  it("keeps one decimal", () => {
    expect(formatCpuPct(12.34)).toBe("12.3%");
  });
});
