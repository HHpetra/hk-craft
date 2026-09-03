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
    ...partial,
  };
}

function sessions(...rows: Array<[string, number]>): DiscoveredSession[] {
  return rows.map(([id, updatedMs]) => ({ id, updatedMs }));
}

describe("assignAgentSessions", () => {
  it("gives each pane a distinct chat, oldest first, when none are claimed yet", () => {
    const next = assignAgentSessions(
      [claim({ paneId: "a1" }), claim({ paneId: "a2" })],
      sessions(["b", 20], ["a", 10]),
    );
    expect(next).toEqual([
      { projectId: "proj", paneId: "a1", sessionId: "a" },
      { projectId: "proj", paneId: "a2", sessionId: "b" },
    ]);
  });

  it("keeps existing claims and fills the other pane from the leftover chats", () => {
    const next = assignAgentSessions(
      [claim({ paneId: "a1", currentId: "a" }), claim({ paneId: "a2" })],
      sessions(["b", 20], ["a", 10]),
    );
    expect(next).toEqual([{ projectId: "proj", paneId: "a2", sessionId: "b" }]);
  });

  it("does not assign the same chat to two panes that already share it", () => {
    const next = assignAgentSessions(
      [claim({ paneId: "a1", currentId: "b" }), claim({ paneId: "a2", currentId: "b" })],
      sessions(["b", 20], ["a", 10]),
    );
    expect(next).toEqual([{ projectId: "proj", paneId: "a2", sessionId: "a" }]);
  });

  it("leaves a second pane unassigned when only one chat exists", () => {
    const next = assignAgentSessions(
      [claim({ paneId: "a1" }), claim({ paneId: "a2" })],
      sessions(["only", 1]),
    );
    expect(next).toEqual([{ projectId: "proj", paneId: "a1", sessionId: "only" }]);
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

  it("does not steal a newer leftover chat when no pane has been typed in", () => {
    const next = assignAgentSessions(
      [claim({ paneId: "a1", currentId: "a" }), claim({ paneId: "a2", currentId: "b" })],
      sessions(["c", 30], ["b", 20], ["a", 10]),
    );
    expect(next).toEqual([]);
  });

  it("in resume mode splits a duplicated stored id but does not fill a fresh pane", () => {
    const split = assignAgentSessions(
      [claim({ paneId: "a1", currentId: "b" }), claim({ paneId: "a2", currentId: "b" })],
      sessions(["b", 20], ["a", 10]),
      "resume",
    );
    expect(split).toEqual([{ projectId: "proj", paneId: "a2", sessionId: "a" }]);

    const fresh = assignAgentSessions(
      [claim({ paneId: "a1", currentId: "a" }), claim({ paneId: "a2" })],
      sessions(["b", 20], ["a", 10]),
      "resume",
    );
    expect(fresh).toEqual([]);

    const unique = assignAgentSessions(
      [claim({ paneId: "a1", currentId: "a" }), claim({ paneId: "a2", currentId: "b" })],
      sessions(["c", 30], ["b", 20], ["a", 10]),
      "resume",
    );
    expect(unique).toEqual([]);

    const unknownStored = assignAgentSessions(
      [claim({ paneId: "a1", currentId: "a" }), claim({ paneId: "a2", currentId: "b" })],
      sessions(["c", 1]),
      "resume",
    );
    expect(unknownStored).toEqual([]);
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
      () => 0,
    );
    expect(calls.sort()).toEqual(["codex", "cursor-agent"]);
    expect(next).toEqual([
      { projectId: "proj", paneId: "c1", sessionId: "chat-a" },
      { projectId: "proj", paneId: "c2", sessionId: "chat-b" },
      { projectId: "proj", paneId: "x1", sessionId: "codex-1" },
    ]);
  });
});
