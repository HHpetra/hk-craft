import type { AgentPreset, Project } from "../types";
import { resolveAgentCommand, resumeHardFails } from "./agentProtocol";

/** A stored chat id that must be verified on disk before it reaches a spawn. */
export type ResumeCheckTarget = {
  paneId: string;
  command: string;
  sessionId: string;
};

/**
 * Panes whose stored chat id has to be checked before the launch is planned.
 *
 * Only agents that hard-exit on an unreadable `--resume` log (dsh-tui: see
 * `resumeFallback`) are listed. Handing one of them a stale id — the session was
 * deleted in the CLI, or it lives under another project directory — boots the
 * pane straight into "cannot resume session" and it never paints, so the caller
 * clears those ids first and lets the pane start a fresh session instead.
 *
 * Agents whose CLI tolerates a vanished log (cursor-agent, claude, codex,
 * opencode) keep their stored id untouched.
 */
export function resumeCheckTargets(project: Project, presets: AgentPreset[]): ResumeCheckTarget[] {
  const targets: ResumeCheckTarget[] = [];
  for (const pane of project.panes ?? []) {
    if (pane.kind !== "agent") continue;
    const sessionId = pane.agent_session_id?.trim();
    if (!sessionId) continue;
    const command = resolveAgentCommand(pane, project, presets);
    if (!resumeHardFails(command)) continue;
    targets.push({ paneId: pane.id, command, sessionId });
  }
  return targets;
}
