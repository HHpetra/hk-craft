import { describe, expect, it } from "vitest";
import type { LiveAgentTarget } from "./agentProtocol";
import {
  assignAgentSessions,
  planCapturedSessions,
  type DiscoveredSession,
  type SessionClaim,
} from "./agentSessionAssign";

function claim(partial: Partial<SessionClaim> & Pick<SessionClaim, "paneId">): SessionClaim {
  return {
    projectId: "proj",
    currentId: null,
    lastUserWrite: 0,
    lastOutput: 0,
    ...partial,
  };
}

function sessions(...rows: Array<[string, number]>): DiscoveredSession[] {
  return rows.map(([id, updatedMs]) => ({ id, updatedMs }));
}

describe("assignAgentSessions", () => {
  it("does not pair idle panes to chats by file recency", () => {
    expect(
      assignAgentSessions(
        [claim({ paneId: "a1" }), claim({ paneId: "a2" })],
        sessions(["b", 20], ["a", 10]),
      ),
    ).toEqual([]);
  });

  it("gives the newest unclaimed chat to the pane that was actually active", () => {
    const next = assignAgentSessions(
      [claim({ paneId: "a1", lastOutput: 10 }), claim({ paneId: "a2", lastOutput: 90 })],
      sessions(["b", 20], ["a", 10]),
    );
    expect(next).toEqual([
      { projectId: "proj", paneId: "a1", sessionId: "a" },
      { projectId: "proj", paneId: "a2", sessionId: "b" },
    ]);
  });

  it("assigns a single unclaimed chat to the only empty pane", () => {
    const next = assignAgentSessions(
      [claim({ paneId: "a1", currentId: "a" }), claim({ paneId: "a2" })],
      sessions(["b", 20], ["a", 10]),
    );
    expect(next).toEqual([{ projectId: "proj", paneId: "a2", sessionId: "b" }]);
  });

  it("keeps each pane's stored chat even when a leftover newer file exists", () => {
    expect(
      assignAgentSessions(
        [claim({ paneId: "a1", currentId: "a" }), claim({ paneId: "a2", currentId: "b" })],
        sessions(["c", 30], ["b", 20], ["a", 10]),
      ),
    ).toEqual([]);
  });

  it("keeps a stored chat that discovery no longer lists", () => {
    expect(
      assignAgentSessions(
        [claim({ paneId: "a1", currentId: "a" }), claim({ paneId: "a2", currentId: "b" })],
        sessions(["c", 1]),
      ),
    ).toEqual([]);
  });

  it("gives the only discovered chat to the more active empty pane", () => {
    const next = assignAgentSessions(
      [claim({ paneId: "a1", lastOutput: 10 }), claim({ paneId: "a2", lastOutput: 90 })],
      sessions(["only", 1]),
    );
    expect(next).toEqual([{ projectId: "proj", paneId: "a2", sessionId: "only" }]);
  });

  it("moves a newer unclaimed chat onto the pane that was typed in last", () => {
    const next = assignAgentSessions(
      [
        claim({ paneId: "a1", currentId: "a", lastUserWrite: 90 }),
        claim({ paneId: "a2", currentId: "b", lastUserWrite: 10 }),
      ],
      sessions(["c", 30], ["b", 20], ["a", 10]),
    );
    expect(next).toEqual([{ projectId: "proj", paneId: "a1", sessionId: "c" }]);
  });

  it("in resume mode clears a duplicated stored id instead of filling by recency", () => {
    const split = assignAgentSessions(
      [claim({ paneId: "a1", currentId: "b" }), claim({ paneId: "a2", currentId: "b" })],
      sessions(["b", 20], ["a", 10]),
      "resume",
    );
    expect(split).toEqual([{ projectId: "proj", paneId: "a2", sessionId: null }]);

    expect(
      assignAgentSessions(
        [claim({ paneId: "a1", currentId: "a" }), claim({ paneId: "a2" })],
        sessions(["b", 20], ["a", 10]),
        "resume",
      ),
    ).toEqual([]);

    expect(
      assignAgentSessions(
        [claim({ paneId: "a1", currentId: "a" }), claim({ paneId: "a2", currentId: "b" })],
        sessions(["c", 30], ["b", 20], ["a", 10]),
        "resume",
      ),
    ).toEqual([]);
  });
});

describe("planCapturedSessions", () => {
  it("discovers once per command+cwd pool and does not mix agent types", async () => {
    const targets: LiveAgentTarget[] = [
      {
        projectId: "proj",
        paneId: "c1",
        command: "cursor-agent",
        cwd: "C:\\work",
        currentSessionId: null,
      },
      {
        projectId: "proj",
        paneId: "c2",
        command: "cursor-agent",
        cwd: "C:\\work",
        currentSessionId: null,
      },
      {
        projectId: "proj",
        paneId: "x1",
        command: "codex",
        cwd: "C:\\work",
        currentSessionId: null,
      },
    ];
    const calls: string[] = [];
    const next = await planCapturedSessions(
      targets,
      async (command) => {
        calls.push(command);
        if (command === "cursor-agent") return sessions(["chat-b", 2], ["chat-a", 1]);
        return sessions(["codex-1", 1]);
      },
      (_projectId, paneId) => ({
        lastUserWrite: 0,
        lastOutput: paneId === "c2" ? 90 : paneId === "c1" ? 10 : 0,
      }),
    );
    expect(calls.sort()).toEqual(["codex", "cursor-agent"]);
    expect(next).toEqual([
      { projectId: "proj", paneId: "c1", sessionId: "chat-a" },
      { projectId: "proj", paneId: "c2", sessionId: "chat-b" },
      { projectId: "proj", paneId: "x1", sessionId: "codex-1" },
    ]);
  });
});
