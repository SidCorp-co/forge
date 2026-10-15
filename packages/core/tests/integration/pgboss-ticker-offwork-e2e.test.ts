/**
 * ISS-1342 — the three tickers that core stops at shutdown, against a real pg-boss 12.
 *
 * Each one hands `offWork` the worker it started. Under pg-boss 10 a lone string was read as a queue
 * name, so the worker id matched nothing and the worker ran on; pg-boss 12 takes the queue name
 * first and the id beside it.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../helpers/index.js';

let harness: TestDatabase;
let queue: typeof import('../../src/queue/boss.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  queue = await import('../../src/queue/boss.js');
  await queue.startBoss();
}, 60_000);

afterAll(async () => {
  await queue?.stopBoss();
  if (harness) await harness.cleanup();
});

function workersOn(name: string): number {
  return queue.boss.getWipData().filter((worker) => worker.name === name).length;
}

/** pg-boss 12's default worker poll, so every live worker has issued a fetch within it. */
const POLL_MS = 2_000;

/**
 * Holds pg-boss's job table locked, so every worker's next fetch blocks on it, until `release()`.
 * Resolves once a fetch is waiting and one more poll has passed, so the ticker's own is too.
 */
async function blockEveryFetch(): Promise<{ release: () => Promise<void> }> {
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = harness.db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE pgboss.job IN ACCESS EXCLUSIVE MODE`);
    locked();
    await released;
  });
  await isLocked;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query ILIKE '%SKIP LOCKED%'
    `);
    if ((rows[0]?.n ?? 0) > 0) break;
    if (Date.now() > deadline) throw new Error('no pg-boss fetch blocked on the locked job table');
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, POLL_MS + 500));
  return {
    release: async () => {
      release();
      await done;
    },
  };
}

const TICKERS = [
  {
    name: 'schedule.tick',
    load: async () => {
      const m = await import('../../src/schedules/runner.js');
      return { start: m.registerScheduleTicker, stop: m.unregisterScheduleTicker };
    },
  },
  {
    name: 'pm.cadence.tick',
    load: async () => {
      const m = await import('../../src/pm/cadence.js');
      return { start: m.registerPmCadenceTicker, stop: m.unregisterPmCadenceTicker };
    },
  },
  {
    name: 'agent.cron.tick',
    load: async () => {
      const m = await import('../../src/agents/cron.js');
      return { start: m.registerAgentCronTicker, stop: m.unregisterAgentCronTicker };
    },
  },
];

describe.each(TICKERS)('the $name ticker', ({ name, load }) => {
  it('stops the worker it started when it is unregistered', async () => {
    const ticker = await load();
    await ticker.start();
    expect(workersOn(name)).toBe(1);

    await ticker.stop();
    expect(workersOn(name)).toBe(0);
  }, 30_000);

  it('is off the worker list when unregistering returns, though its fetch was in flight', async () => {
    const ticker = await load();
    await ticker.start();
    const fetches = await blockEveryFetch();

    const left = ticker.stop().then(() => workersOn(name));
    await new Promise((r) => setTimeout(r, 200));
    await fetches.release();

    expect(await left).toBe(0);
  }, 30_000);
});
