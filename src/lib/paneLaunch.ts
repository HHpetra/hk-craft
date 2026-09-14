import type { AgentPreset, Project, SessionStatus, SpawnOpts, WorkspacePane } from "../types";
import { DEFAULT_DOCKER_SHELLS, type DockerLaunchInput } from "./dockerLaunch";
import { paneSessionId, terminalPanes } from "./panes";
import { commandPayload } from "./quickCommands";
import { resolveAgentCommand, resolvePresetCommand, resumeArgsForSession, resumeHardFails } from "./agentProtocol";

export type LaunchMode = "ensure" | "restart";

export type AgentRestartReason =
  | { kind: "preset-commands"; prevPresets: AgentPreset[]; nextPresets: AgentPreset[] }
  | { kind: "theme" };

export type AgentPaneRef = {
  projectId: string;
  paneId: string;
};

export type PaneLaunchPlan =
  | { action: "skip"; sessionId: string }
  | { action: "spawn"; kind: "runner"; sessionId: string; killFirst: boolean; spawn: SpawnOpts }
  | {
      action: "spawn";
      kind: "agent";
      sessionId: string;
      killFirst: boolean;
      spawn: SpawnOpts;
      resumeFallback: SpawnOpts | null;
      markAgentSeen: boolean;
    }
  | { action: "spawn"; kind: "docker"; sessionId: string; killFirst: boolean; input: DockerLaunchInput };

function isLive(status: SessionStatus | undefined) {
  return status === "running" || status === "waiting";
}

function skipPlan(sessionId: string): PaneLaunchPlan {
  return { action: "skip", sessionId };
}

function dockerPostWrite(pane: Extract<WorkspacePane, { kind: "docker" }>): string | null {
  if (!pane.docker_auto_exec) return null;
  const body = pane.docker_exec_command ?? "";
  if (!body.trim()) return null;
  return commandPayload(body);
}

export function planPaneLaunch(input: {
  mode: LaunchMode;
  project: Project;
  pane: WorkspacePane;
  presets: AgentPreset[];
  resumeOnStart: boolean;
  status: SessionStatus | undefined;
  agentSeen: boolean;
}): PaneLaunchPlan | null {
  const sessionId = paneSessionId(input.project.id, input.pane);
  if (!sessionId) return null;

  if (input.mode === "ensure" && isLive(input.status)) {
    return skipPlan(sessionId);
  }

  const cwd = input.project.path;
  const killFirst = input.mode === "restart";

  if (input.pane.kind === "runner") {
    return {
      action: "spawn",
      kind: "runner",
      sessionId,
      killFirst,
      spawn: { sessionId, cwd, command: "" },
    };
  }

  if (input.pane.kind === "docker") {
    return {
      action: "spawn",
      kind: "docker",
      sessionId,
      killFirst,
      input: {
        sessionId,
        cwd,
        container: input.pane.docker_container?.trim() ?? "",
        shells: [...DEFAULT_DOCKER_SHELLS],
        postWrite: dockerPostWrite(input.pane),
        killFirst,
      },
    };
  }

  if (input.pane.kind !== "agent") return null;

  const command = resolveAgentCommand(input.pane, input.project, input.presets);
  const resume = input.resumeOnStart ? resumeArgsForSession(command, input.pane.agent_session_id) : [];
  const spawn: SpawnOpts = { sessionId, cwd, command, args: resume };
  const resumeFallback: SpawnOpts | null =
    resume.length > 0 && resumeHardFails(command) ? { sessionId, cwd, command, args: [] } : null;

  return {
    action: "spawn",
    kind: "agent",
    sessionId,
    killFirst,
    spawn,
    resumeFallback,
    markAgentSeen: input.mode === "ensure" && !input.agentSeen,
  };
}

export type PlannedPaneLaunch = {
  paneId: string;
  plan: Extract<PaneLaunchPlan, { action: "spawn" }>;
};

/**
 * Plan every terminal pane of a project for the "ensure" (open/activate) flow.
 *
 * Pure: the caller injects how to read the current session status. Live panes
 * are skipped inside `planPaneLaunch`, explorer panes yield no session id, and
 * only real spawn plans come back — so the caller just executes them.
 */
export function planProjectLaunches(input: {
  project: Project;
  presets: AgentPreset[];
  resumeOnStart: boolean;
  statusOf: (sessionId: string) => SessionStatus | undefined;
}): PlannedPaneLaunch[] {
  const launches: PlannedPaneLaunch[] = [];
  for (const pane of terminalPanes(input.project)) {
    const sessionId = paneSessionId(input.project.id, pane);
    const plan = planPaneLaunch({
      mode: "ensure",
      project: input.project,
      pane,
      presets: input.presets,
      resumeOnStart: input.resumeOnStart,
      status: sessionId ? input.statusOf(sessionId) : undefined,
      agentSeen: input.project.agent_seen,
    });
    if (!plan || plan.action === "skip") continue;
    launches.push({ paneId: pane.id, plan });
  }
  return launches;
}

export function agentPanesToRestart(
  openedProjectIds: string[],
  projects: Project[],
  reason: AgentRestartReason,
): AgentPaneRef[] {
  const opened = new Set(openedProjectIds);
  const refs: AgentPaneRef[] = [];
  for (const project of projects) {
    if (!opened.has(project.id)) continue;
    for (const pane of project.panes ?? []) {
      if (reason.kind === "theme") {
        // Agent and Runner inherit TERM_THEME / COLORFGBG at spawn.
        if (pane.kind === "agent" || pane.kind === "runner") {
          refs.push({ projectId: project.id, paneId: pane.id });
        }
        continue;
      }
      if (pane.kind !== "agent") continue;
      const prevCmd = resolvePresetCommand(pane, project, reason.prevPresets);
      const nextCmd = resolvePresetCommand(pane, project, reason.nextPresets);
      if (prevCmd !== nextCmd) {
        refs.push({ projectId: project.id, paneId: pane.id });
      }
    }
  }
  return refs;
}
