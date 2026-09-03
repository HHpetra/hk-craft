import { agentBin, type LiveAgentTarget } from "./agentProtocol";
import { normalizeFsPath } from "./format";

export type DiscoveredSession = {
  id: string;
  updatedMs: number;
};

export type SessionClaim = {
  projectId: string;
  paneId: string;
  currentId: string | null | undefined;
  lastUserWrite: number;
};

export type SessionAssignment = {
  projectId: string;
  paneId: string;
  sessionId: string;
};

function sessionPoolKey(command: string, cwd: string) {
  return `${agentBin(command)}\0${normalizeFsPath(cwd).toLowerCase()}`;
}

function uniqueById(discovered: DiscoveredSession[]): DiscoveredSession[] {
  const byId = new Map<string, DiscoveredSession>();
  for (const session of discovered) {
    const id = session.id.trim();
    if (!id) continue;
    const prev = byId.get(id);
    if (!prev || session.updatedMs > prev.updatedMs) byId.set(id, { id, updatedMs: session.updatedMs });
  }
  return [...byId.values()].sort((a, b) => b.updatedMs - a.updatedMs || a.id.localeCompare(b.id));
}

export type AssignMode = "capture" | "resume";

/**
 * Map discovered agent chats onto panes of the same command+cwd without collisions.
 *
 * Existing claims that still exist are kept. A second pane that stored the same
 * id is given a leftover chat so two identical agents never resume one session.
 * In capture mode, unclaimed panes are filled oldest-first (first pane matches
 * the first spawned chat), and a newer leftover chat goes to the pane typed in last.
 * Resume mode only splits duplicate stored ids — empty panes stay empty so a
 * newly added Agent starts a fresh chat.
 */
export function assignAgentSessions(
  claims: SessionClaim[],
  discovered: DiscoveredSession[],
  mode: AssignMode = "capture",
): SessionAssignment[] {
  if (claims.length === 0) return [];
  const sessions = uniqueById(discovered);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const assigned = new Map<string, string>();
  const used = new Set<string>();

  for (const claim of claims) {
    const current = claim.currentId?.trim();
    if (!current || !byId.has(current) || used.has(current)) continue;
    assigned.set(claim.paneId, current);
    used.add(current);
  }

  const hungry = claims.filter((claim) => {
    if (assigned.has(claim.paneId)) return false;
    if (mode === "resume") {
      const current = claim.currentId?.trim();
      return Boolean(current && used.has(current));
    }
    return true;
  });
  const unusedOldestFirst = [...sessions].reverse().filter((session) => !used.has(session.id));
  for (const session of unusedOldestFirst) {
    const claim = hungry.shift();
    if (!claim) break;
    assigned.set(claim.paneId, session.id);
    used.add(session.id);
  }

  if (mode === "capture") {
    for (const session of sessions) {
      if (used.has(session.id)) continue;
      let best: SessionClaim | null = null;
      for (const claim of claims) {
        const current = assigned.get(claim.paneId);
        if (!current) continue;
        const currentMeta = byId.get(current);
        if (!currentMeta || currentMeta.updatedMs >= session.updatedMs) continue;
        if (claim.lastUserWrite <= 0) continue;
        if (!best || claim.lastUserWrite > best.lastUserWrite) best = claim;
      }
      if (!best) continue;
      const previous = assigned.get(best.paneId);
      if (previous) used.delete(previous);
      assigned.set(best.paneId, session.id);
      used.add(session.id);
    }
  }

  const next: SessionAssignment[] = [];
  for (const claim of claims) {
    const sessionId = assigned.get(claim.paneId);
    if (!sessionId || sessionId === (claim.currentId ?? "")) continue;
    next.push({ projectId: claim.projectId, paneId: claim.paneId, sessionId });
  }
  return next;
}

export async function planCapturedSessions(
  targets: LiveAgentTarget[],
  discover: (command: string, cwd: string) => Promise<DiscoveredSession[]>,
  lastUserWrite: (projectId: string, paneId: string) => number,
  mode: AssignMode = "capture",
): Promise<SessionAssignment[]> {
  const groups = new Map<string, LiveAgentTarget[]>();
  for (const target of targets) {
    const key = sessionPoolKey(target.command, target.cwd);
    const group = groups.get(key);
    if (group) group.push(target);
    else groups.set(key, [target]);
  }

  const assignments: SessionAssignment[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    let discovered: DiscoveredSession[] = [];
    try {
      discovered = await discover(first.command, first.cwd);
    } catch {
      continue;
    }
    const claims: SessionClaim[] = group.map((target) => ({
      projectId: target.projectId,
      paneId: target.paneId,
      currentId: target.currentSessionId,
      lastUserWrite: lastUserWrite(target.projectId, target.paneId),
    }));
    assignments.push(...assignAgentSessions(claims, discovered, mode));
  }
  return assignments;
}
