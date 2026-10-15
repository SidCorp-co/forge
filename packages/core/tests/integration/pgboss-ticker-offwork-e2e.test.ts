/**
 * ISS-1342 — the three tickers that core stops at shutdown, against a real pg-boss 12.
 *
 * Each one hands `offWork` the worker it started. Under pg-boss 10 a lone string was read as a queue
 * name, so the worker id matched nothing and the worker ran on; pg-boss 12 takes the queue name
 * first and the id beside it.
 */

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
});
