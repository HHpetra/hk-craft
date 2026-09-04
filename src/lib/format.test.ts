import { describe, expect, it } from "vitest";
import { parseSessionId, sessionId } from "./format";

describe("session id", () => {
  it("builds and parses agent, runner, and docker ids", () => {
    expect(sessionId("p", "agent", "a1")).toBe("p:agent:a1");
    expect(sessionId("p", "runner", "r1")).toBe("p:runner:r1");
    expect(sessionId("p", "docker", "d1")).toBe("p:docker:d1");
    expect(parseSessionId("p:docker:d1")).toEqual({ projectId: "p", kind: "docker", paneId: "d1" });
    expect(parseSessionId("p:agent:a1")).toEqual({ projectId: "p", kind: "agent", paneId: "a1" });
    expect(parseSessionId("p:explorer:e1")).toBeNull();
    expect(parseSessionId("bad")).toBeNull();
  });
});
