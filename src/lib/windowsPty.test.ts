import { describe, expect, it } from "vitest";
import { CONPTY_MODERN_BUILD, windowsPtyOptions } from "./windowsPty";

describe("windowsPtyOptions", () => {
  it("returns modern conpty options on Windows", () => {
    expect(windowsPtyOptions("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toEqual({
      backend: "conpty",
      buildNumber: CONPTY_MODERN_BUILD,
    });
    expect(CONPTY_MODERN_BUILD).toBeGreaterThanOrEqual(21376);
  });

  it("is unset on non-Windows hosts", () => {
    expect(windowsPtyOptions("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBeUndefined();
    expect(windowsPtyOptions("Mozilla/5.0 (X11; Linux x86_64)")).toBeUndefined();
    expect(windowsPtyOptions("")).toBeUndefined();
  });
});
