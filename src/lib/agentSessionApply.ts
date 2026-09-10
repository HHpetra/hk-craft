import type { AppConfig } from "../types";
import type { SessionAssignment } from "./agentSessionAssign";

/**
 * Apply captured/assigned chat ids back onto agent panes in the config.
 *
 * Pure data transform: given the current config and a set of assignments
 * (projectId + paneId -> sessionId | null), return a new config only when at
 * least one agent pane's stored id actually changed; otherwise return null so
 * callers can skip an unnecessary persist.
 */
export function applySessionAssignments(
  config: AppConfig,
  assignments: SessionAssignment[],
): AppConfig | null {
  if (assignments.length === 0) return null;

  const byProject = new Map<string, Map<string, string | null>>();
  for (const assignment of assignments) {
    const panes = byProject.get(assignment.projectId) ?? new Map<string, string | null>();
    panes.set(assignment.paneId, assignment.sessionId);
    byProject.set(assignment.projectId, panes);
  }

  let changed = false;
  const projects = config.projects.map((project) => {
    const paneUpdates = byProject.get(project.id);
    if (!paneUpdates) return project;
    let projectChanged = false;
    const panes = project.panes.map((pane) => {
      if (!paneUpdates.has(pane.id) || pane.kind !== "agent") return pane;
      const nextId = paneUpdates.get(pane.id) ?? null;
      if ((pane.agent_session_id ?? null) === nextId) return pane;
      projectChanged = true;
      changed = true;
      return { ...pane, agent_session_id: nextId };
    });
    return projectChanged ? { ...project, panes } : project;
  });

  return changed ? { ...config, projects } : null;
}
