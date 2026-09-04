import { describe, expect, it } from "vitest";
import { quietWaitShouldResolve, shouldInjectPostWrite } from "./ptyQuiet";

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
