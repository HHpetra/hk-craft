import { agentBin, resumeHardFails, type LiveAgentTarget } from "./agentProtocol";
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
  lastOutput: number;
};

export type SessionAssignment = {
  projectId: string;
  paneId: string;
  sessionId: string | null;
};

export type PaneActivity = {
  lastUserWrite: number;
  lastOutput: number;
};

export type AssignMode = "capture" | "resume";

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

function activity(claim: SessionClaim) {
  return Math.max(claim.lastUserWrite, claim.lastOutput);
}

function pickMostActive(claims: SessionClaim[]): SessionClaim {
  return claims.reduce((best, claim) => (activity(claim) > activity(best) ? claim : best));
}

function diffsFromAssigned(claims: SessionClaim[], assigned: Map<string, string | null>): SessionAssignment[] {
  const next: SessionAssignment[] = [];
  for (const claim of claims) {
    if (!assigned.has(claim.paneId)) continue;
    const sessionId = assigned.get(claim.paneId) ?? null;
    if (sessionId === (claim.currentId ?? null)) continue;
    next.push({ projectId: claim.projectId, paneId: claim.paneId, sessionId });
  }
  return next;
}

export type ResumeAssignOptions = {
  /** Drop stored ids that discovery does not list (dsh-tui hard-exits on a missing log). */
  dropMissingStored?: boolean;
};

/** Later panes that stored the same chat id as an earlier pane are cleared so they start fresh. Empty panes pick up an unclaimed discovered chat so spawn can pass --resume. Occupied panes are never stolen. */
function assignResumeSessions(
  claims: SessionClaim[],
  discovered: DiscoveredSession[],
  options: ResumeAssignOptions = {},
): SessionAssignment[] {
  const sessions = uniqueById(discovered);
  const assigned = new Map<string, string | null>();
  const used = new Set<string>();

  const known = new Set(sessions.map((session) => session.id));
  const dropMissing = options.dropMissingStored === true;

  for (const claim of claims) {
    const current = claim.currentId?.trim();
    if (!current) continue;
    // dsh-tui hard-exits on --resume of a missing log. Cursor/Claude keep the
    // stored id even when discovery is incomplete — otherwise a valid chat is
    // wiped and replaced with an unrelated file.
    if (dropMissing && known.size > 0 && !known.has(current)) {
      assigned.set(claim.paneId, null);
      continue;
    }
    if (used.has(current)) assigned.set(claim.paneId, null);
    else {
      assigned.set(claim.paneId, current);
      used.add(current);
    }
  }

  for (const session of sessions) {
    if (used.has(session.id)) continue;
    const hungry = claims.filter((claim) => {
      if (!assigned.has(claim.paneId)) return true;
      return assigned.get(claim.paneId) === null;
    });
    let pick: SessionClaim | undefined;
    if (hungry.length === 1) {
      pick = hungry[0];
    } else if (hungry.length > 1) {
      const active = hungry.filter((claim) => activity(claim) > 0);
      if (active.length === 0) continue;
      pick = pickMostActive(active);
    } else {
      continue;
    }
    assigned.set(pick.paneId, session.id);
    used.add(session.id);
  }

  return diffsFromAssigned(claims, assigned);
}

/**
 * Bind discovered chats to panes by identity, not by recency order.
 *
 * Capture keeps each pane's stored id. A new unclaimed chat is given to the pane
 * that was actually active (PTY input/output), never to "the first pane" just
 * because its file is older. Resume keeps stored ids (clearing duplicates) and
 * fills a still-empty pane from discovery so the next spawn can pass --resume.
 */
export function assignAgentSessions(
  claims: SessionClaim[],
  discovered: DiscoveredSession[],
  mode: AssignMode = "capture",
  resumeOptions: ResumeAssignOptions = {},
): SessionAssignment[] {
  if (claims.length === 0) return [];
  if (mode === "resume") return assignResumeSessions(claims, discovered, resumeOptions);

  const sessions = uniqueById(discovered);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const assigned = new Map<string, string | null>();
  const used = new Set<string>();

  for (const claim of claims) {
    const current = claim.currentId?.trim();
    if (!current || used.has(current)) continue;
    assigned.set(claim.paneId, current);
    used.add(current);
  }

  for (const session of sessions) {
    if (used.has(session.id)) continue;

    const hungry = claims.filter((claim) => !assigned.has(claim.paneId));
    let pick: SessionClaim | undefined;

    if (hungry.length === 1) {
      pick = hungry[0];
    } else if (hungry.length > 1) {
      const active = hungry.filter((claim) => activity(claim) > 0);
      if (active.length === 0) continue;
      pick = pickMostActive(active);
    } else {
      const active = claims.filter((claim) => activity(claim) > 0);
      if (active.length === 0) continue;
      const best = pickMostActive(active);
      const previous = assigned.get(best.paneId);
      if (previous) {
        const previousMeta = byId.get(previous);
        if (previousMeta && previousMeta.updatedMs >= session.updatedMs) continue;
      }
      pick = best;
    }

    if (!pick) continue;
    const previous = assigned.get(pick.paneId);
    if (previous) used.delete(previous);
    assigned.set(pick.paneId, session.id);
    used.add(session.id);
  }

  return diffsFromAssigned(claims, assigned);
}

export async function planCapturedSessions(
  targets: LiveAgentTarget[],
  discover: (command: string, cwd: string) => Promise<DiscoveredSession[]>,
  paneActivity: (projectId: string, paneId: string) => PaneActivity,
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
    const claims: SessionClaim[] = group.map((target) => {
      const activity = paneActivity(target.projectId, target.paneId);
      return {
        projectId: target.projectId,
        paneId: target.paneId,
        currentId: target.currentSessionId,
        lastUserWrite: activity.lastUserWrite,
        lastOutput: activity.lastOutput,
      };
    });
    if (mode === "resume") {
      let discovered: DiscoveredSession[] = [];
      try {
        discovered = await discover(first.command, first.cwd);
      } catch {
        discovered = [];
      }
      assignments.push(
        ...assignAgentSessions(claims, discovered, "resume", {
          dropMissingStored: resumeHardFails(first.command),
        }),
      );
      continue;
    }
    let discovered: DiscoveredSession[] = [];
    try {
      discovered = await discover(first.command, first.cwd);
    } catch {
      continue;
    }
    assignments.push(...assignAgentSessions(claims, discovered, "capture"));
  }
  return assignments;
}
