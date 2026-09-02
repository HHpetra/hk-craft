import type { AgentPreset, PaneKind, Project, WorkspaceLayout, WorkspacePane } from "../types";
import { sessionId } from "./format";

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
  return { ...project, layout, panes, active_pane_id: active };
}

export function paneSessionId(projectId: string, pane: WorkspacePane) {
  if (pane.kind === "explorer") return null;
  return sessionId(projectId, pane.kind, pane.id);
}

export function terminalPanes(project: Project) {
  return (project.panes ?? []).filter((pane) => pane.kind === "agent" || pane.kind === "runner");
}

export function paneTitle(pane: WorkspacePane, panes: WorkspacePane[], presets: AgentPreset[]) {
  const base =
    pane.kind === "explorer"
      ? "资源管理"
      : pane.kind === "runner"
        ? "终端"
        : (presets.find((preset) => preset.id === pane.preset_id)?.name ?? "Agent");
  const same = panes.filter(
    (other) =>
      other.kind === pane.kind && (pane.kind !== "agent" || other.preset_id === pane.preset_id),
  );
  if (same.length <= 1) return base;
  const index = same.findIndex((other) => other.id === pane.id);
  return index <= 0 ? base : `${base} ${index + 1}`;
}

export function neighborPaneId(panes: WorkspacePane[], closedId: string) {
  const index = panes.findIndex((pane) => pane.id === closedId);
  if (index === -1) return panes[0]?.id ?? null;
  return panes[index + 1]?.id ?? panes[index - 1]?.id ?? null;
}

export function createPane(kind: PaneKind, presetId?: string): WorkspacePane {
  if (kind === "agent") {
    return { id: crypto.randomUUID(), kind, preset_id: presetId ?? null };
  }
  return { id: crypto.randomUUID(), kind };
}
