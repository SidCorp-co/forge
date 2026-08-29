/**
 * A parked duplex session survives the quiet clock — against real Postgres.
 *
 * ISS-873 phase 2. The heartbeat hop's predicate is the whole claim, and the
 * unit lane cannot fail on it: `loop-monitor.test.ts` mocks `db.update()` and
 * captures the `where` as an opaque drizzle object, so a predicate that
 * excluded the wrong rows — or every row — passes there unchanged.
 *
 * Two directions matter equally. A session parked on a human must not be
 * reaped at 3 minutes, and a print-mode session (which reports no state at all)
 * must still be, or the exemption silently covers the whole fleet.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let projectId: string;
let reapZombieSessions: typeof import('../../src/jobs/loop-monitor.js').reapZombieSessions;

// cm:guard an ISO string, NOT a Date. Bound inside a raw `sql` template postgres-js has no column type to serialise a Date against and throws ERR_INVALID_ARG_TYPE on bind — the same trap `loop-monitor.ts` records on its own ackFast cutoff.
const STALE = new Date(Date.now() - 60 * 60_000).toISOString();

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  // cm:guard the broadcast and wedge paths are stubbed, not the predicate. Mocking the reaper itself would leave this file asserting that a mock was called, which is exactly the evidence the unit lane already fails to provide.
  vi.mock('../../src/ws/broadcast.js', () => ({
    broadcast: vi.fn(),
    broadcastToProject: vi.fn(),
  }));
  ({ reapZombieSessions } = await import('../../src/jobs/loop-monitor.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const ownerId = (await createTestUser(harness.db)).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
});

async function runningSession(runtimeState: string | null): Promise<string> {
  const id = randomUUID();
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    VALUES (${runId}, ${projectId}, 'interactive', 'running', ${STALE}::timestamptz)
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions
      (id, project_id, pipeline_run_id, status, metadata, started_at, last_heartbeat_at,
       runtime_state, created_at, updated_at)
    VALUES (${id}, ${projectId}, ${runId}, 'running',
            ${JSON.stringify({ type: 'pipeline' })}::jsonb,
            ${STALE}::timestamptz, ${STALE}::timestamptz, ${runtimeState},
            ${STALE}::timestamptz, ${STALE}::timestamptz)
  `);
  return id;
}

async function statusOf(id: string): Promise<{ status: string; reason: string | null }> {
  const rows = await harness.db.execute<{ status: string; failure_reason: string | null }>(sql`
    SELECT status, failure_reason FROM agent_sessions WHERE id = ${id}
  `);
  const row = rows[0];
  return { status: row?.status ?? 'gone', reason: row?.failure_reason ?? null };
}

describe('the quiet clock and the park', () => {
  it('leaves a session parked on a human alone, however long it has been quiet', async () => {
    const id = await runningSession('awaiting_input');
    await reapZombieSessions(new Date());
    expect(await statusOf(id)).toEqual({ status: 'running', reason: null });
  });

  // cm:guard the discriminating half. A print-mode session reports NO state, and reading NULL as "maybe parked" would exempt every job still on the old path from the heartbeat hop — the exemption would quietly become fleet-wide on the day it shipped.
  it('still reaps a session that reports no state at all', async () => {
    const id = await runningSession(null);
    const after = await statusOf(id);
    expect(after.status).toBe('running');
    await reapZombieSessions(new Date());
    expect(await statusOf(id)).toEqual({ status: 'failed', reason: 'heartbeat_timeout' });
  });

  it('still reaps a session that says it is working', async () => {
    const id = await runningSession('working');
    await reapZombieSessions(new Date());
    expect((await statusOf(id)).status).toBe('failed');
  });

  it('reaps a session that has been closed rather than treating it as parked', async () => {
    const id = await runningSession('closed');
    await reapZombieSessions(new Date());
    expect((await statusOf(id)).status).toBe('failed');
  });

  it('separates the two in one sweep rather than exempting the batch', async () => {
    const parked = await runningSession('awaiting_input');
    const quiet = await runningSession(null);
    await reapZombieSessions(new Date());
    expect((await statusOf(parked)).status).toBe('running');
    expect((await statusOf(quiet)).status).toBe('failed');
  });
});
