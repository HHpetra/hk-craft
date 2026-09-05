import { describe, expect, it } from "vitest";
import { classifyResumeBootOutput, quietWaitShouldResolve, shouldInjectPostWrite } from "./ptyQuiet";

describe("quietWaitShouldResolve", () => {
  it("waits until output has been quiet long enough", () => {
    expect(
      quietWaitShouldResolve({
        startedAt: 0,
        lastOutputAt: null,
        now: 300,
        quietMs: 400,
        timeoutMs: 8000,
      }),
    ).toBe(false);
    expect(
      quietWaitShouldResolve({
        startedAt: 0,
        lastOutputAt: 100,
        now: 300,
        quietMs: 400,
        timeoutMs: 8000,
      }),
    ).toBe(false);
    expect(
      quietWaitShouldResolve({
        startedAt: 0,
        lastOutputAt: 100,
        now: 500,
        quietMs: 400,
        timeoutMs: 8000,
      }),
    ).toBe(true);
  });

  it("resolves on timeout even without output", () => {
    expect(
      quietWaitShouldResolve({
        startedAt: 0,
        lastOutputAt: null,
        now: 8000,
        quietMs: 400,
        timeoutMs: 8000,
      }),
    ).toBe(true);
  });
});

describe("shouldInjectPostWrite", () => {
  it("injects after quiet or timeout while the PTY is still alive", () => {
    expect(shouldInjectPostWrite("quiet")).toBe(true);
    expect(shouldInjectPostWrite("timeout", "Welcome")).toBe(true);
    expect(shouldInjectPostWrite("timeout", "")).toBe(true);
    expect(shouldInjectPostWrite("exited")).toBe(false);
    expect(shouldInjectPostWrite("cancelled")).toBe(false);
  });
});

describe("classifyResumeBootOutput", () => {
  it("treats dsh-tui's explicit resume failure as fatal", () => {
    expect(
      classifyResumeBootOutput(
        'dsh-tui: cannot resume session "abc": missing log — Drop --resume to start fresh',
      ),
    ).toBe("fatal");
    expect(classifyResumeBootOutput("\x1b[?1049h")).toBe("alive");
    expect(classifyResumeBootOutput("x".repeat(800))).toBe("unknown");
    expect(classifyResumeBootOutput("booting")).toBe("unknown");
    expect(
      classifyResumeBootOutput(
        "\x1b[?1004h\x1b[?9001h\x1b[?1049h\x1b[2J\x1b[H\x1b[?1000h",
      ),
    ).toBe("alive");
  });
});
