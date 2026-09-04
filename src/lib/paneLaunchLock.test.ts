import { describe, expect, it } from "vitest";
import {
  beginPaneLaunch,
  cancelPaneLaunch,
  endPaneLaunch,
  isPaneLaunching,
  requestPaneRelaunch,
  takePendingRelaunch,
} from "./paneLaunchLock";

describe("paneLaunchLock", () => {
  it("rejects a second begin until the first launch ends", () => {
    const id = `lock-${Math.random()}`;
    const signal = beginPaneLaunch(id);
    expect(signal).not.toBeNull();
    expect(isPaneLaunching(id)).toBe(true);
    expect(beginPaneLaunch(id)).toBeNull();
    endPaneLaunch(id);
    expect(isPaneLaunching(id)).toBe(false);
    expect(beginPaneLaunch(id)).not.toBeNull();
    endPaneLaunch(id);
  });

  it("tracks sessions independently", () => {
    const a = `lock-a-${Math.random()}`;
    const b = `lock-b-${Math.random()}`;
    expect(beginPaneLaunch(a)).not.toBeNull();
    expect(beginPaneLaunch(b)).not.toBeNull();
    expect(beginPaneLaunch(a)).toBeNull();
    endPaneLaunch(a);
    expect(beginPaneLaunch(a)).not.toBeNull();
    endPaneLaunch(a);
    endPaneLaunch(b);
  });

  it("aborts the current launch and queues a relaunch", () => {
    const id = `relaunch-${Math.random()}`;
    const signal = beginPaneLaunch(id);
    expect(signal?.aborted).toBe(false);
    requestPaneRelaunch(id);
    expect(signal?.aborted).toBe(true);
    expect(isPaneLaunching(id)).toBe(true);
    endPaneLaunch(id);
    expect(takePendingRelaunch(id)).toBe(true);
    expect(takePendingRelaunch(id)).toBe(false);
  });

  it("drops a queued relaunch when the pane is cancelled", () => {
    const id = `cancel-${Math.random()}`;
    const signal = beginPaneLaunch(id);
    requestPaneRelaunch(id);
    cancelPaneLaunch(id);
    expect(signal?.aborted).toBe(true);
    endPaneLaunch(id);
    expect(takePendingRelaunch(id)).toBe(false);
  });
});
