import type { AgentPreset, Project, SessionStatus, WorkspacePane } from "../types";
import protocolFile from "./agent-protocol.json";
import { paneSessionId } from "./panes";

export type AgentProtocolEntry = {
  bins: string[];
  resume: string;
  discover?: string;
};

const DEFAULT_COMMAND = "cursor-agent";
const agents = protocolFile.agents as AgentProtocolEntry[];

export function agentBin(command: string): string {
  return (
    command
      .trim()
      .split(/\s+/)[0]
      ?.replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/\.(exe|cmd)$/i, "")
      .toLowerCase() ?? ""
  );
}

export function protocolForCommand(command: string): AgentProtocolEntry | undefined {
  const bin = agentBin(command);
  return agents.find((entry) => entry.bins.includes(bin));
}

export function resumeArgsForSession(command: string, sessionId: string | null | undefined): string[] {
  if (!sessionId?.trim()) return [];
  const spec = protocolForCommand(command);
  if (!spec) return [];
  return [spec.resume, sessionId];
}

export function resolvePresetCommand(
  pane: WorkspacePane,
  project: Project,
  presets: AgentPreset[],
): string | undefined {
  const presetId = pane.preset_id ?? project.agent_preset;
  return presets.find((preset) => preset.id === presetId)?.command;
}

export function resolveAgentCommand(
  pane: WorkspacePane,
  project: Project,
  presets: AgentPreset[],
): string {
  return resolvePresetCommand(pane, project, presets) ?? DEFAULT_COMMAND;
}

export type LiveAgentTarget = {
  projectId: string;
  paneId: string;
  command: string;
  cwd: string;
};

function isLive(status: SessionStatus | undefined) {
  return status === "running" || status === "waiting";
}

export function liveAgentTargets(
  projects: Project[],
  openedProjectIds: string[],
  sessionStatus: Record<string, SessionStatus | undefined>,
  presets: AgentPreset[],
): LiveAgentTarget[] {
  const opened = new Set(openedProjectIds);
  const targets: LiveAgentTarget[] = [];
  for (const project of projects) {
    if (!opened.has(project.id)) continue;
    for (const pane of project.panes ?? []) {
      if (pane.kind !== "agent") continue;
      const sid = paneSessionId(project.id, pane);
      if (!sid || !isLive(sessionStatus[sid])) continue;
      targets.push({
        projectId: project.id,
        paneId: pane.id,
        command: resolveAgentCommand(pane, project, presets),
        cwd: project.path,
      });
    }
  }
  return targets;
}
