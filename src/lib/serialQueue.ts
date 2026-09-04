/** Run async tasks one after another. A failed task does not skip later ones. */
export function createSerialQueue() {
  let chain: Promise<void> = Promise.resolve();

  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export function resolveQueuedUpdate<T extends object>(
  current: T | null,
  next: T | ((current: T) => T),
): T | null {
  if (typeof next === "function") return current ? next(current) : null;
  return next;
}

