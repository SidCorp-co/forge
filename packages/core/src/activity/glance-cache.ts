// What the workspace's Activity read keeps off its path (ISS-951 round 2). The page reads the whole
// workspace on every move of any project; two of its legs cost seconds there, because each reads a
// project whole: its next release by forecast, and the decisions it owes the reader. Each answer is
// kept per key and read again behind the page once it is older than its freshness; a read waits for
// a key it never held only up to a budget. A key still unread answers `read: false`, which the row
// says as pending, never as nothing (VISION: state-never-lies), and a read that started a refresh
// says so, so the page reads once more when it lands rather than polling.

import { logger } from '../lib/logger.js';

export type Glance<V> = { read: true; value: V } | { read: false };

export interface GlanceRead<V> {
  values: Map<string, Glance<V>>;
  /** Whether any key is still being read behind the page as this read answers. */
  refreshing: boolean;
}

export function glanceCache<V>(
  name: string,
  freshMs: number,
  readOne: (key: string) => Promise<V>,
) {
  const held = new Map<string, { value: V; readAt: number }>();
  const reading = new Map<string, Promise<void>>();

  /** Read one key once at a time; a failed read keeps what was held and is logged. */
  const refresh = (key: string): Promise<void> => {
    const running = reading.get(key);
    if (running) return running;
    const started = readOne(key)
      .then((value) => {
        held.set(key, { value, readAt: Date.now() });
      })
      .catch((err: unknown) => {
        logger.warn({ err, key }, `org activity: ${name} could not be read`);
      })
      .finally(() => reading.delete(key));
    reading.set(key, started);
    return started;
  };

  return {
    async read(keys: readonly string[], budgetMs: number): Promise<GlanceRead<V>> {
      const now = Date.now();
      const missing: Promise<void>[] = [];
      for (const key of keys) {
        const h = held.get(key);
        if (!h) missing.push(refresh(key));
        else if (now - h.readAt > freshMs) void refresh(key);
      }
      if (missing.length > 0) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.all(missing),
          new Promise<void>((done) => {
            timer = setTimeout(done, budgetMs);
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
    /** Forget every held answer: a test's world reads its own. */
    forget(): void {
      held.clear();
    },
  };
}
