import { describe, expect, it } from "vitest";
import { createSerialQueue, resolveQueuedUpdate } from "./serialQueue";

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("createSerialQueue", () => {
  it("runs enqueued tasks in order even if a later one finishes faster", async () => {
    const enqueue = createSerialQueue();
    const order: number[] = [];
    const first = enqueue(async () => {
      await delay(30);
      order.push(1);
      return "a";
    });
    const second = enqueue(async () => {
      order.push(2);
      return "b";
    });
    await expect(Promise.all([first, second])).resolves.toEqual(["a", "b"]);
    expect(order).toEqual([1, 2]);
  });

  it("keeps later tasks after an earlier failure", async () => {
    const enqueue = createSerialQueue();
    const first = enqueue(async () => {
      throw new Error("boom");
    });
    const second = enqueue(async () => "ok");
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
  });

  it("applies sequential patches against the latest value so parallel writers do not clobber each other", async () => {
    const enqueue = createSerialQueue();
    let config: { seen: boolean; sessionA: string | null; sessionB: string | null } = {
      seen: false,
      sessionA: "old",
      sessionB: "old",
    };

    const markSeen = enqueue(async () => {
      await delay(20);
      config = { ...config, seen: true };
    });
    const clearA = enqueue(async () => {
      config = { ...config, sessionA: null };
    });
    const clearB = enqueue(async () => {
      config = { ...config, sessionB: null };
    });

    await Promise.all([markSeen, clearA, clearB]);
    expect(config).toEqual({ seen: true, sessionA: null, sessionB: null });
  });
});

describe("resolveQueuedUpdate", () => {
  it("applies an updater to the latest value, and skips when current is missing", () => {
    expect(resolveQueuedUpdate({ a: 1, b: 2 }, (current) => ({ ...current, a: 9 }))).toEqual({
      a: 9,
      b: 2,
    });
    expect(resolveQueuedUpdate<{ a: number }>(null, (current) => current)).toBeNull();
    expect(resolveQueuedUpdate({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("keeps other fields when the write is an updater, unlike a full snapshot", () => {
    const current = { seen: true, layout: "tabs" };
    expect(resolveQueuedUpdate(current, { seen: false, layout: "row" })).toEqual({
      seen: false,
      layout: "row",
    });
    expect(resolveQueuedUpdate(current, (latest) => ({ ...latest, layout: "row" }))).toEqual({
      seen: true,
      layout: "row",
    });
  });
});
