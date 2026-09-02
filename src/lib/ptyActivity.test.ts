import { describe, expect, it } from "vitest";
import {
  createPtyActivityTrack,
  decidePtyExit,
  decidePtySilence,
  ECHO_GRACE_MS,
  notePtyOutput,
  NOTIFY_BUSY_MS,
  USER_WAIT_MS,
} from "./ptyActivity";

describe("pty activity interpretation", () => {
  it("does not start a busy clock for echo of recent keystrokes", () => {
    const track = createPtyActivityTrack();
    const typed = 1_000;
    track.lastUserWrite = typed;
    notePtyOutput(track, typed + ECHO_GRACE_MS - 1);
    expect(track.runningSince).toBeNull();
    notePtyOutput(track, typed + ECHO_GRACE_MS + 1);
    expect(track.runningSince).toBe(typed + ECHO_GRACE_MS + 1);
  });

  it("treats silence after editing the prompt as waiting, not a finished task", () => {
    const track = createPtyActivityTrack();
    const now = 20_000;
    track.runningSince = now - NOTIFY_BUSY_MS - 1;
    track.lastUserWrite = now - USER_WAIT_MS + 10;
    expect(decidePtySilence(track, "running", now)).toEqual({ notify: false, toWaiting: true });
  });

  it("notifies after a long busy period goes silent without recent typing", () => {
    const track = createPtyActivityTrack();
    const now = 30_000;
    track.runningSince = now - NOTIFY_BUSY_MS;
    track.lastUserWrite = now - USER_WAIT_MS - 1;
    expect(decidePtySilence(track, "running", now)).toEqual({ notify: true, toWaiting: true });
    expect(decidePtySilence(track, "waiting", now)).toEqual({ notify: false, toWaiting: false });
  });

  it("notifies on process exit only if the pane was busy long enough", () => {
    const short = createPtyActivityTrack();
    short.runningSince = 100;
    expect(decidePtyExit(short, true, 100 + NOTIFY_BUSY_MS - 1)).toEqual({
      notify: false,
      status: "exited",
    });
    expect(short.runningSince).toBeNull();

    const long = createPtyActivityTrack();
    long.runningSince = 100;
    expect(decidePtyExit(long, false, 100 + NOTIFY_BUSY_MS)).toEqual({
      notify: true,
      status: "error",
    });
  });
});
