import type { AgentPreset, Project, SessionStatus, SpawnOpts, WorkspacePane } from "../types";
import { resolveAgentCommand, resolvePresetCommand, resumeArgsForSession } from "./agentProtocol";
import { paneSessionId } from "./panes";

export type LaunchMode = "ensure" | "restart";

export type AgentRestartReason =
  | { kind: "preset-commands"; prevPresets: AgentPreset[]; nextPresets: AgentPreset[] }
  | { kind: "theme" };

export type AgentPaneRef = {
  projectId: string;
  paneId: string;
};

export type PaneLaunchPlan = {
  sessionId: string;
  action: "skip" | "spawn";
  killFirst: boolean;
  spawn: SpawnOpts | null;
  fallbackSpawn: SpawnOpts | null;
  /** Persist `agent_seen` only after the primary spawn succeeds — not after resume fallback. */
  markAgentSeen: boolean;
  clearSessionOnFallback: boolean;
  failNoticePrefix: "Agent" | "Runner";
};

function isLive(status: SessionStatus | undefined) {
  return status === "running" || status === "waiting";
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

  const failNoticePrefix = input.pane.kind === "runner" ? "Runner" : "Agent";
  if (input.mode === "ensure" && isLive(input.status)) {
    return {
      sessionId,
      action: "skip",
      killFirst: false,
      spawn: null,
      fallbackSpawn: null,
      markAgentSeen: false,
      clearSessionOnFallback: false,
      failNoticePrefix,
    };
  }

  const cwd = input.project.path;
  const killFirst = input.mode === "restart";

  if (input.pane.kind === "runner") {
    return {
      sessionId,
      action: "spawn",
      killFirst,
      spawn: { sessionId, cwd, command: "" },
      fallbackSpawn: null,
      markAgentSeen: false,
      clearSessionOnFallback: false,
      failNoticePrefix: "Runner",
    };
  }

  const command = resolveAgentCommand(input.pane, input.project, input.presets);
  const resume = input.resumeOnStart ? resumeArgsForSession(command, input.pane.agent_session_id) : [];
  const spawn: SpawnOpts = { sessionId, cwd, command, args: resume };
  const fallbackSpawn: SpawnOpts | null =
    resume.length > 0 ? { sessionId, cwd, command, args: [] } : null;

  return {
    sessionId,
    action: "spawn",
    killFirst,
    spawn,
    fallbackSpawn,
    markAgentSeen: input.mode === "ensure" && !input.agentSeen,
    clearSessionOnFallback: Boolean(fallbackSpawn),
    failNoticePrefix: "Agent",
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
