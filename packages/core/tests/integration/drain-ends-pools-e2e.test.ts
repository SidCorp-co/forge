// @direct-test-of packages/core/src/index.ts
// @direct-test-of packages/core/src/shutdown.ts
// @direct-test-of packages/core/src/integrations/rocketchat/connection-manager.ts
// ISS-1020: a draining core gives back every Postgres connection it holds, so the container a deploy
// stops returns its whole budget to the server the new one shares. Read from Postgres's own
// pg_stat_activity, by the name each client gives its connections.
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { coreShutdownSteps } from '../../src/index.js';
import { startRocketChatManager } from '../../src/integrations/rocketchat/index.js';
import { CONNECTION_NAMES } from '../../src/lib/connection-budget.js';
import { consumeRateLimit } from '../../src/middleware/rate-limit.js';
import { startBoss } from '../../src/queue/boss.js';
import { runShutdown } from '../../src/shutdown.js';

const adminUrl = process.env.TEST_PG_ADMIN_URL;
const fileUrl = process.env.DATABASE_URL;
if (!adminUrl || !fileUrl) throw new Error('the integration setup did not run');
const database = decodeURIComponent(new URL(fileUrl).pathname.slice(1));
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });

afterAll(async () => {
  await admin.end({ timeout: 5 });
});

type Held = Record<keyof typeof CONNECTION_NAMES, number>;

async function held(): Promise<Held> {
  const rows = await admin<{ name: string; n: number }[]>`
    SELECT application_name AS name, count(*)::int AS n FROM pg_stat_activity
    WHERE datname = ${database} AND application_name IN ${admin(Object.values(CONNECTION_NAMES))}
    GROUP BY application_name`;
  const count = (name: string) => rows.find((r) => r.name === name)?.n ?? 0;
  return {
    queries: count(CONNECTION_NAMES.queries),
    queue: count(CONNECTION_NAMES.queue),
    rateLimit: count(CONNECTION_NAMES.rateLimit),
    session: count(CONNECTION_NAMES.session),
  };
}

/** A backend leaves pg_stat_activity a moment after its client ends: read until it has, or 5 s. */
async function heldOnceSettled(): Promise<Held> {
  const deadline = Date.now() + 5_000;
  let now = await held();
  while (Object.values(now).some((n) => n > 0) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    now = await held();
  }
  return now;
}

describe('core shutting down', () => {
  it('ends every pool it opened: queries, queue, rate limiter and the chat session', async () => {
    await startBoss();
    await db.execute(sql`select 1`);
    await consumeRateLimit('iss-1020-drain', 10, 60_000);
    await startRocketChatManager();

    const before = await held();
    expect(before.queries).toBeGreaterThan(0);
    expect(before.queue).toBeGreaterThan(0);
    expect(before.rateLimit).toBe(1);
    expect(before.session).toBe(1);

    const listener = { close: (cb?: (err?: Error) => void) => cb?.() };
    const code = await runShutdown('SIGTERM', listener, coreShutdownSteps, {
      httpDrainMs: 1_000,
      timeoutMs: 20_000,
    });
    expect(code).toBe(0);

    expect(await heldOnceSettled()).toEqual({ queries: 0, queue: 0, rateLimit: 0, session: 0 });
  });
});
