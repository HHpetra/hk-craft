import type { AgentPreset, Project, PtySessionStat, SessionKind } from "../types";
import { parseSessionId } from "./format";
import { paneTitle } from "./panes";
import { sessionKindLabel } from "./status";

export const OTHER_PROJECT_ID = "__other__";
export const OTHER_PROJECT_NAME = "其他";

export type SessionStatRow = {
  sessionId: string;
  kind: SessionKind | null;
  paneId: string;
  title: string;
  pid: number;
  memoryBytes: number;
  cpuPct: number;
  processCount: number;
  docker: boolean;
};

export type SessionStatGroup = {
  projectId: string;
  projectName: string;
  rows: SessionStatRow[];
  memoryBytes: number;
  cpuPct: number;
};

export type SessionStatTotals = {
  memoryBytes: number;
  cpuPct: number;
  processCount: number;
  sessions: number;
};

export function formatCpuPct(value: number) {
  return `${value.toFixed(1)}%`;
}

export function groupSessionStats(
  stats: PtySessionStat[],
  projects: Project[],
  openedProjectIds: readonly string[],
  presets: AgentPreset[],
): SessionStatGroup[] {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const opened = new Set(openedProjectIds);
  const buckets = new Map<string, SessionStatRow[]>();

  for (const stat of stats) {
    const parsed = parseSessionId(stat.session_id);
    if (!parsed) {
      pushRow(buckets, OTHER_PROJECT_ID, rowFromUnknown(stat));
      continue;
    }
    const project = projectById.get(parsed.projectId);
    const groupId = project && opened.has(project.id) ? project.id : OTHER_PROJECT_ID;
    pushRow(buckets, groupId, rowFromParsed(stat, parsed.kind, parsed.paneId, project, presets));
  }

  const groups: SessionStatGroup[] = [];
  for (const id of openedProjectIds) {
    const rows = buckets.get(id);
    if (!rows?.length) continue;
    groups.push(makeGroup(id, projectById.get(id)?.name ?? id, rows));
  }
  const other = buckets.get(OTHER_PROJECT_ID);
  if (other?.length) {
    groups.push(makeGroup(OTHER_PROJECT_ID, OTHER_PROJECT_NAME, other));
  }
  return groups;
}

export function totalSessionStats(groups: SessionStatGroup[]): SessionStatTotals {
  return groups.reduce<SessionStatTotals>(
    (acc, group) => {
      acc.memoryBytes += group.memoryBytes;
      acc.cpuPct += group.cpuPct;
      acc.sessions += group.rows.length;
      for (const row of group.rows) acc.processCount += row.processCount;
      return acc;
    },
    { memoryBytes: 0, cpuPct: 0, processCount: 0, sessions: 0 },
  );
}

function makeGroup(projectId: string, projectName: string, rows: SessionStatRow[]): SessionStatGroup {
  return {
    projectId,
    projectName,
    rows,
    memoryBytes: rows.reduce((sum, row) => sum + row.memoryBytes, 0),
    cpuPct: rows.reduce((sum, row) => sum + row.cpuPct, 0),
  };
}

function pushRow(buckets: Map<string, SessionStatRow[]>, id: string, row: SessionStatRow) {
  const list = buckets.get(id);
  if (list) list.push(row);
  else buckets.set(id, [row]);
}

function rowFromUnknown(stat: PtySessionStat): SessionStatRow {
  return {
    sessionId: stat.session_id,
    kind: null,
    paneId: "",
    title: stat.session_id,
    pid: stat.pid,
    memoryBytes: stat.memory_bytes,
    cpuPct: stat.cpu_pct,
    processCount: stat.process_count,
    docker: false,
  };
}

function rowFromParsed(
  stat: PtySessionStat,
  kind: SessionKind,
  paneId: string,
  project: Project | undefined,
  presets: AgentPreset[],
): SessionStatRow {
  const pane = project?.panes.find((item) => item.id === paneId);
  const title =
    pane && project ? paneTitle(pane, project.panes, presets) : sessionKindLabel(kind);
  return {
    sessionId: stat.session_id,
    kind,
    paneId,
    title,
    pid: stat.pid,
    memoryBytes: stat.memory_bytes,
    cpuPct: stat.cpu_pct,
    processCount: stat.process_count,
    docker: kind === "docker",
  };
}
