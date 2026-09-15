import { describe, expect, it } from "vitest";
import { updatePromptCopy } from "./updateCheck";

describe("updatePromptCopy", () => {
  it("names the new and current versions", () => {
    expect(updatePromptCopy("0.6.0", "0.5.0")).toEqual({
      title: "发现新版本 v0.6.0",
      message: "当前为 v0.5.0",
    });
  });

  it("strips a leading v from tags", () => {
    expect(updatePromptCopy("v0.6.0", "v0.5.0")).toEqual({
      title: "发现新版本 v0.6.0",
      message: "当前为 v0.5.0",
    });
  });
});
