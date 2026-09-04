import { describe, expect, it } from "vitest";
import { isSessionKind, paneCaps, SESSION_KINDS } from "./paneCaps";

describe("paneCaps", () => {
  it("marks only terminal kinds as sessions", () => {
    expect(SESSION_KINDS).toEqual(["agent", "runner", "docker"]);
    expect(isSessionKind("agent")).toBe(true);
    expect(isSessionKind("docker")).toBe(true);
    expect(isSessionKind("explorer")).toBe(false);
  });

  it("describes drop, quick commands, and edit per kind", () => {
    expect(paneCaps("agent")).toMatchObject({
      terminal: true,
      acceptsPathDrop: true,
      quickCommands: false,
      contextEdit: null,
      sizeBucket: "agent",
    });
    expect(paneCaps("runner")).toMatchObject({
      terminal: true,
      acceptsPathDrop: true,
      quickCommands: true,
      contextEdit: null,
    });
    expect(paneCaps("docker")).toMatchObject({
      terminal: true,
      acceptsPathDrop: false,
      quickCommands: true,
      contextEdit: "docker",
      sizeBucket: "docker",
    });
    expect(paneCaps("explorer").terminal).toBe(false);
  });
});
