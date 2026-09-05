import type { AppConfig, OpencodeHookEvent } from "../types";
import { parseSessionId } from "./format";

export type OpencodeHookAssignment = {
  projectId: string;
  paneId: string;
  sessionId: string;
};

/** Map a plugin report onto an open agent pane, or skip closed / non-agent sessions. */
export function assignmentFromOpencodeHook(
  event: OpencodeHookEvent,
  config: AppConfig | null | undefined,
): OpencodeHookAssignment | null {
  const parsed = parseSessionId(event.session_id);
  if (!parsed || parsed.kind !== "agent") return null;
  const id = event.opencode_id.trim();
  if (!id.startsWith("ses_") || id.length > 64) return null;
  const project = config?.projects.find((item) => item.id === parsed.projectId);
  const pane = project?.panes.find((item) => item.id === parsed.paneId);
  if (!pane || pane.kind !== "agent") return null;
  if ((pane.agent_session_id ?? null) === id) return null;
  return { projectId: parsed.projectId, paneId: parsed.paneId, sessionId: id };
}
