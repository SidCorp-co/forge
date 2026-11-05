// @direct-test-of packages/core/src/db/client.ts
// @direct-test-of packages/core/src/queue/boss.ts
// @direct-test-of packages/core/src/middleware/rate-limit.ts
// @direct-test-of packages/core/src/lib/env.ts
import { describe, expect, it } from 'vitest';
import { queryClientOptions } from '../db/client.js';
import { storePoolOptions } from '../middleware/rate-limit.js';
import { bossOptions } from '../queue/boss.js';
import {
  CONNECTION_NAMES,
  connectionBudget,
  DEFAULT_DATABASE_CONNECTIONS,
  MIN_DATABASE_CONNECTIONS,
} from './connection-budget.js';
import { env } from './env.js';

describe('connectionBudget', () => {
  it('splits the default twelve so the widest read runs unqueued and two containers hold 24', () => {
    expect(connectionBudget(DEFAULT_DATABASE_CONNECTIONS)).toEqual({
      total: 12,
      queries: 8,
      queue: 2,
      rateLimit: 1,
      session: 1,
    });
    expect(2 * DEFAULT_DATABASE_CONNECTIONS).toBeLessThanOrEqual(24);
  });

  it('gives out exactly the total, never more, at every size it accepts', () => {
    for (let total = MIN_DATABASE_CONNECTIONS; total <= 200; total++) {
      const b = connectionBudget(total);
      expect(b.queries + b.queue + b.rateLimit + b.session).toBe(total);
      expect(b.queries).toBeGreaterThanOrEqual(4);
      expect(b.queue).toBeGreaterThanOrEqual(2);
    }
  });

  it('refuses a total too small for the query pool, or not a whole number, by name', () => {
    for (const bad of [MIN_DATABASE_CONNECTIONS - 1, 0, -12, 12.5, Number.NaN]) {
      expect(() => connectionBudget(bad)).toThrow(/^DATABASE_CONNECTIONS=.* at least 8/);
    }
  });
});

describe('the clients draw their pools from the budget', () => {
  const budget = connectionBudget(env.DATABASE_CONNECTIONS);

  it('reads the default total when DATABASE_CONNECTIONS is unset', () => {
    expect(env.DATABASE_CONNECTIONS).toBe(DEFAULT_DATABASE_CONNECTIONS);
  });

  it('sizes each pool at its share and names it in pg_stat_activity', () => {
    const query = queryClientOptions();
    const queue = bossOptions();
    const store = storePoolOptions();
    expect(query.max).toBe(budget.queries);
    expect(query.connection.application_name).toBe(CONNECTION_NAMES.queries);
    expect(queue.max).toBe(budget.queue);
    expect(queue.application_name).toBe(CONNECTION_NAMES.queue);
    expect(queue.useListenNotify ?? false).toBe(false);
    expect(store.max).toBe(budget.rateLimit);
    expect(store.application_name).toBe(CONNECTION_NAMES.rateLimit);
    expect(store.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it('holds no more than the total across every client, the chat session included', () => {
    const held =
      (queryClientOptions().max ?? 0) +
      (bossOptions().max ?? 0) +
      (storePoolOptions().max ?? 0) +
      budget.session;
    expect(held).toBe(env.DATABASE_CONNECTIONS);
  });
});
