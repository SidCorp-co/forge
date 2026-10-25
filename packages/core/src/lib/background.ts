// Work no request waits on: an audit row, a token's last use, an embedding, a page refresh. Each runs
// after its response is sent, and each writes. Started through `background()`, every such write is
// known to `backgroundSettled()`, so a caller that must not empty or close the database under one
// (a test's reset, a shutdown) can wait them out instead of deadlocking against them.

const everyRunning = new Set<Promise<void>>();

export interface Background {
  /** Starts `work` without waiting on it; a throw goes to `failed`, never to the caller. */
  start(work: () => Promise<unknown>, failed: (err: unknown) => void): void;
  /** Settles every piece of work this one started, including any started while it waits. */
  settled(): Promise<void>;
}

async function drain(running: Set<Promise<void>>): Promise<void> {
  while (running.size > 0) await Promise.all([...running]);
}

/** A named kind of background work, whose own `settled()` waits on it alone. */
export function background(): Background {
  const running = new Set<Promise<void>>();
  return {
    start(work, failed) {
      const done: Promise<void> = Promise.resolve()
        .then(work)
        .then(() => undefined)
        .catch(failed)
        .finally(() => {
          running.delete(done);
          everyRunning.delete(done);
        });
      running.add(done);
      everyRunning.add(done);
    },
    settled: () => drain(running),
  };
}

/** Settles all background work in this process, including any started while it waits. */
export function backgroundSettled(): Promise<void> {
  return drain(everyRunning);
}
