import type { AgentPreset, Project, SessionStatus, SpawnOpts, WorkspacePane } from "../types";
import { DEFAULT_DOCKER_SHELLS, type DockerLaunchInput } from "./dockerLaunch";
import { paneSessionId } from "./panes";
import { commandPayload } from "./quickCommands";
import { resolveAgentCommand, resolvePresetCommand, resumeArgsForSession } from "./agentProtocol";

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
    resume.length > 0 ? { sessionId, cwd, command, args: [] } : null;

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
      if (pane.kind !== "agent") continue;
      if (reason.kind === "theme") {
        refs.push({ projectId: project.id, paneId: pane.id });
        continue;
      }
      const prevCmd = resolvePresetCommand(pane, project, reason.prevPresets);
      const nextCmd = resolvePresetCommand(pane, project, reason.nextPresets);
      if (prevCmd !== nextCmd) {
        refs.push({ projectId: project.id, paneId: pane.id });
      }
    }
  }
  return refs;
}
