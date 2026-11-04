// What the workspace's Activity read keeps off its path (ISS-951). Two of its legs cost seconds,
// because each reads a project whole: its next release by forecast, and the decisions it owes the
// reader. Each answer is kept per key and read again behind the page once it is older than its
// freshness. A key still unread answers `read: false`, which the row says as pending, never as nothing
// (VISION: state-never-lies), and a read that started a refresh says so, so the page reads once more
// when it lands rather than polling.
//
// Round 3: a read never waits on these legs, and what it starts behind the page runs `concurrency`
// at a time and only after the read's own statements are queued. Round 2 started every key's refresh
// at once in the request's own tick; thirteen forecasts and thirteen Needs you reads, each a hundred
// statements, took the ten-connection pool from the page's own legs, and the read waited on the pool
// for 12.6 s live (and a cold read of six projects took 1.06 s in the round's own test).

import { withoutQueryTiming } from '../db/query-timing.js';
import { createLimiter } from '../lib/bounded-concurrency.js';
import { logger } from '../lib/logger.js';

export type Glance<V> = { read: true; value: V } | { read: false };

export interface GlanceRead<V> {
  values: Map<string, Glance<V>>;
  /** Whether any key is still being read behind the page as this read answers. */
  refreshing: boolean;
}

export interface GlanceCacheOptions {
  /** How many keys are read behind the page at once: the pool connections this cache may hold. */
  concurrency: number;
}

export function glanceCache<V>(
  name: string,
  freshMs: number,
  readOne: (key: string) => Promise<V>,
  opts: GlanceCacheOptions = { concurrency: 1 },
) {
  const held = new Map<string, { value: V; readAt: number }>();
  const reading = new Map<string, Promise<void>>();
  const limiter = createLimiter(opts.concurrency);

  /**
   * Read one key once at a time, behind the read that asked: it starts on the next turn of the event
   * loop, so the asking read's statements reach the pool first. A failed read keeps what was held.
   */
  const refresh = (key: string): Promise<void> => {
    const running = reading.get(key);
    if (running) return running;
    // every promise of the read is made outside the asking request's timing, so its statements are
    // never counted as the request's own (`db/query-timing.ts:withoutQueryTiming`)
    const started = withoutQueryTiming(() =>
      new Promise<void>((next) => setImmediate(next))
        .then(() => limiter.run(() => readOne(key)))
        .then((value) => {
          held.set(key, { value, readAt: Date.now() });
        })
        .catch((err: unknown) => {
          logger.warn({ err, key }, `org activity: ${name} could not be read`);
        })
        .finally(() => reading.delete(key)),
    );
    reading.set(key, started);
    return started;
  };

  return {
    /**
     * What is held for each key, at once. A key held for longer than its freshness, or never held, is
     * read again behind the answer. `waitMs` lets a caller that needs the answer (a test, a warm-up)
     * wait for the keys it never held, up to that long; the page's read passes none.
     */
    async read(keys: readonly string[], waitMs = 0): Promise<GlanceRead<V>> {
      const now = Date.now();
      const missing: Promise<void>[] = [];
      for (const key of keys) {
        const h = held.get(key);
        if (!h) missing.push(refresh(key));
        else if (now - h.readAt > freshMs) void refresh(key);
      }
      if (missing.length > 0 && waitMs > 0) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.all(missing),
          new Promise<void>((done) => {
            timer = setTimeout(done, waitMs);
          }),
        ]);
        clearTimeout(timer);
      }
      const values = new Map(
        keys.map((key): [string, Glance<V>] => {
          const h = held.get(key);
          return [key, h ? { read: true, value: h.value } : { read: false }];
        }),
      );
      return { values, refreshing: keys.some((key) => reading.has(key)) };
    },
    /** How many keys are being read behind the page now, at most `concurrency` of them at once. */
    get inFlight(): number {
      return limiter.inFlight;
    },
    /** Forget every held answer: a test's world reads its own. */
    forget(): void {
      held.clear();
    },
  };
}
