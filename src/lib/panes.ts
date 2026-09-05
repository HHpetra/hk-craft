import type {
  AgentPreset,
  AppConfig,
  PaneKind,
  Project,
  SessionKind,
  SessionStatus,
  WorkspaceLayout,
  WorkspacePane,
} from "../types";
import { sessionId } from "./format";
import { paneCaps } from "./paneCaps";

export function normalizeLayout(value: string | undefined): WorkspaceLayout {
  if (value === "tabs" || value === "row" || value === "grid") return value;
  return "row";
}

export function seedDefaultPanes(agentPreset: string, agentSessionId?: string | null): WorkspacePane[] {
  return [
    { id: crypto.randomUUID(), kind: "explorer" },
    {
      id: crypto.randomUUID(),
      kind: "agent",
      preset_id: agentPreset,
      agent_session_id: agentSessionId ?? null,
    },
    { id: crypto.randomUUID(), kind: "runner" },
  ];
}

export function withDefaultWorkspace(project: Omit<Project, "layout" | "active_pane_id" | "panes"> & Partial<Project>): Project {
  const panes = project.panes?.length ? project.panes : seedDefaultPanes(project.agent_preset, project.agent_session_id);
  const layout = normalizeLayout(project.layout);
  const active =
    project.active_pane_id && panes.some((pane) => pane.id === project.active_pane_id)
      ? project.active_pane_id
      : (panes[0]?.id ?? null);
  return { stowed: false, quick_commands: [], ...project, layout, panes, active_pane_id: active };
}

export function isTerminalPane(pane: WorkspacePane): pane is Exclude<WorkspacePane, { kind: "explorer" }> {
  return paneCaps(pane.kind).terminal;
}

export function paneSessionId(projectId: string, pane: WorkspacePane) {
  if (!isTerminalPane(pane)) return null;
  return sessionId(projectId, pane.kind, pane.id);
}

export function terminalPanes(project: Project) {
  return (project.panes ?? []).filter(isTerminalPane);
}

export function projectSessionIds(projectId: string, project: Project | undefined | null): string[] {
  if (!project) return [];
  return terminalPanes(project)
    .map((pane) => paneSessionId(projectId, pane))
    .filter((sid): sid is string => Boolean(sid));
}

export type ActiveSession = { projectName: string; kind: SessionKind };

export type ActiveSessionSnapshot = {
  config: AppConfig | null | undefined;
  openedProjectIds: string[];
  sessionStatus: Record<string, SessionStatus | undefined>;
};

function isActiveStatus(status: SessionStatus | undefined) {
  return status === "running" || status === "waiting";
}

/** Opened terminal panes whose PTY is still running or waiting (idle / exited / error excluded). */
export function activeRunningSessions(snapshot: ActiveSessionSnapshot): ActiveSession[] {
  if (!snapshot.config) return [];
  const found: ActiveSession[] = [];
  for (const project of snapshot.config.projects) {
    if (!snapshot.openedProjectIds.includes(project.id)) continue;
    for (const pane of terminalPanes(project)) {
      const sid = paneSessionId(project.id, pane);
      if (!sid) continue;
      if (!isActiveStatus(snapshot.sessionStatus[sid])) continue;
      found.push({ projectName: project.name, kind: pane.kind });
    }
  }
  return found;
}

export function paneTitle(pane: WorkspacePane, panes: WorkspacePane[], presets: AgentPreset[]) {
  const label = paneCaps(pane.kind).label;
  const base =
    pane.kind === "docker"
      ? (pane.docker_container?.trim() || label)
      : pane.kind === "agent"
        ? (presets.find((preset) => preset.id === pane.preset_id)?.name ?? label)
        : label;
  const same = panes.filter((other) => {
    if (other.kind !== pane.kind) return false;
    if (pane.kind === "agent" && other.kind === "agent") return other.preset_id === pane.preset_id;
    if (pane.kind === "docker" && other.kind === "docker") {
      return (other.docker_container ?? "") === (pane.docker_container ?? "");
    }
    return true;
  });
  if (same.length <= 1) return base;
  const index = same.findIndex((other) => other.id === pane.id);
  return index <= 0 ? base : `${base} ${index + 1}`;
}

export function neighborPaneId(panes: WorkspacePane[], closedId: string) {
  const index = panes.findIndex((pane) => pane.id === closedId);
  if (index === -1) return panes[0]?.id ?? null;
  return panes[index + 1]?.id ?? panes[index - 1]?.id ?? null;
}

export function createPane(kind: Exclude<PaneKind, "docker">, presetId?: string): WorkspacePane {
  if (kind === "agent") {
    return { id: crypto.randomUUID(), kind, preset_id: presetId ?? null };
  }
  return { id: crypto.randomUUID(), kind };
}

export function createDockerPane(input: {
  container: string;
  autoExec: boolean;
  command: string;
}): Extract<WorkspacePane, { kind: "docker" }> {
  return {
    id: crypto.randomUUID(),
    kind: "docker",
    docker_container: input.container.trim(),
    docker_auto_exec: input.autoExec,
    docker_exec_command: input.command,
  };
}
