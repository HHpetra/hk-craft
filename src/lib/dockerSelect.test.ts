import { describe, expect, it } from "vitest";
import { canSubmitDockerPane, resolveDockerSelection } from "./dockerSelect";

describe("resolveDockerSelection", () => {
  it("keeps the saved name when it is still listed", () => {
    expect(resolveDockerSelection("web", ["db", "web"])).toEqual({
      selected: "web",
      missing: false,
      empty: false,
    });
  });

  it("keeps the saved name and marks missing instead of picking the first row", () => {
    expect(resolveDockerSelection("gone", ["alpha", "beta"])).toEqual({
      selected: "gone",
      missing: true,
      empty: false,
    });
  });

  it("falls back to the first listed name only when adding a new pane", () => {
    expect(resolveDockerSelection("", ["alpha", "beta"])).toEqual({
      selected: "alpha",
      missing: false,
      empty: false,
    });
  });

  it("keeps an empty selection when there are no containers", () => {
    expect(resolveDockerSelection("", [])).toEqual({
      selected: "",
      missing: false,
      empty: true,
    });
    expect(resolveDockerSelection("gone", [])).toEqual({
      selected: "gone",
      missing: true,
      empty: true,
    });
  });
});

describe("canSubmitDockerPane", () => {
  const base = {
    editing: false,
    loading: false,
    listed: false,
    listFailed: false,
    selected: "",
    original: "",
  };

  it("allows connect when the current name is listed", () => {
    expect(canSubmitDockerPane({ ...base, listed: true, selected: "web" })).toBe(true);
    expect(canSubmitDockerPane({ ...base, editing: true, listed: true, selected: "db", original: "web" })).toBe(true);
  });

  it("blocks a missing name when docker ps succeeded", () => {
    expect(canSubmitDockerPane({ ...base, selected: "gone" })).toBe(false);
    expect(canSubmitDockerPane({ ...base, editing: true, selected: "gone", original: "gone" })).toBe(false);
  });

  it("allows edit-save of auto-exec on the original name when docker ps failed", () => {
    expect(
      canSubmitDockerPane({
        ...base,
        editing: true,
        listFailed: true,
        selected: "web",
        original: "web",
      }),
    ).toBe(true);
  });

  it("does not add a new pane when docker ps failed", () => {
    expect(canSubmitDockerPane({ ...base, listFailed: true, selected: "web" })).toBe(false);
  });

  it("does not save a different name while docker ps is down", () => {
    expect(
      canSubmitDockerPane({
        ...base,
        editing: true,
        listFailed: true,
        selected: "other",
        original: "web",
      }),
    ).toBe(false);
  });
});
