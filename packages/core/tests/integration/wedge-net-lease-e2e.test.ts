/**
 * ISS-1317 — the autonomous wedge net reads the run's lease before it rolls an issue back, and a
 * reset it does make says so on the issue. Real Postgres: every claim is what `issues` and
 * `comments` hold after a pass.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ws/broadcast.js', () => ({
  broadcast: vi.fn(),
  broadcastToProject: vi.fn(),
}));

import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let seq = 0;

let reconciler: typeof import('../../src/pipeline/reconciler.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  reconciler = await import('../../src/pipeline/reconciler.js');
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, ownerId)).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
});

const MINUTE = 60_000;

function lease(fields: Record<string, unknown>): Record<string, unknown> {
  return { holder: 'iss-run-1', minutes: 60, renewedAt: new Date().toISOString(), ...fields };
}

const liveLease = () => lease({ renewedAt: new Date(Date.now() - 5 * MINUTE).toISOString() });
const lapsedLease = () =>
  lease({ renewedAt: new Date(Date.now() - 61 * MINUTE).toISOString(), minutes: 60 });

/** An `in_progress` issue whose latest job is a `done` `drive` job, whose issue run has ended and
 *  which nothing has written for two days — every term of the wedge read but the lease. */
async function wedged(sessionLease: unknown, id: string = randomUUID()): Promise<string> {
  seq += 1;
  const context = sessionLease === undefined ? {} : { lease: sessionLease };
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, assignee_id,
                        session_context, updated_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'in_progress', ${ownerId}, ${ownerId},
            ${JSON.stringify(context)}::jsonb, now() - interval '2 days')
  `);
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at, finished_at)
    VALUES (${runId}, ${projectId}, ${id}, 'issue', 'failed', now() - interval '2 days',
            now() - interval '2 days')
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, payload, queued_at,
                      created_by, created_at)
    VALUES (${randomUUID()}, ${projectId}, ${id}, ${runId}, 'drive', 'done', '{}'::jsonb,
            now() - interval '2 days', ${ownerId}, now() - interval '2 days')
  `);
  await harness.db.execute(
    sql`UPDATE issues SET updated_at = now() - interval '2 days' WHERE id = ${id}`,
  );
  return id;
}

async function statusOf(id: string): Promise<string> {
  const rows = await harness.db.execute(sql`SELECT status FROM issues WHERE id = ${id}`);
  return String((rows[0] as { status: unknown }).status);
}

async function commentsOn(id: string): Promise<string[]> {
  const rows = await harness.db.execute(
    sql`SELECT body FROM comments WHERE issue_id = ${id} ORDER BY created_at`,
  );
  return rows.map((r) => String((r as { body: unknown }).body));
}

async function lockWaiter(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const rows = await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND datname = current_database()
    `);
    if ((rows[0] as { n: number }).n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('nothing waited on the issue row this test holds');
}

/** Holds the issue row while `write` runs on it uncommitted, starts `act`, and commits once `act`
 *  is waiting on the row — so `act`'s read chose the row before the write and locks it after. */
async function whileRowIsHeld<T>(
  issueId: string,
  write: (tx: Parameters<Parameters<typeof harness.db.transaction>[0]>[0]) => Promise<unknown>,
  act: () => Promise<T>,
): Promise<T> {
  let acted: Promise<T> | undefined;
  await harness.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM issues WHERE id = ${issueId} FOR UPDATE`);
    await write(tx);
    acted = act();
    acted.catch(() => {});
    await lockWaiter();
  });
  return acted as Promise<T>;
}

describe('the wedge net reads the lease (ISS-1317)', () => {
  it('leaves an issue whose run holds a live lease at in_progress', async () => {
    const id = await wedged(liveLease());
    expect(await reconciler.resetAutonomousWedgesOnce()).toBe(0);
    expect(await statusOf(id)).toBe('in_progress');
    expect(await commentsOn(id)).toEqual([]);
  });

  it('moves the same issue to open once its lease has lapsed', async () => {
    const id = await wedged(liveLease());
    await reconciler.resetAutonomousWedgesOnce();
    expect(await statusOf(id)).toBe('in_progress');

    await harness.db.execute(sql`
      UPDATE issues SET session_context = ${JSON.stringify({ lease: lapsedLease() })}::jsonb,
                        updated_at = now() - interval '2 days'
      WHERE id = ${id}
    `);
    expect(await reconciler.resetAutonomousWedgesOnce()).toBe(1);
    expect(await statusOf(id)).toBe('open');
  });

  it('is not held by a lease that was given back', async () => {
    const id = await wedged(lease({ stopped: new Date().toISOString() }));
    await reconciler.resetAutonomousWedgesOnce();
    expect(await statusOf(id)).toBe('open');
    const [body] = await commentsOn(id);
    expect(body).toContain('had been given back');
  });

  it('is not held by a lease the classifier cannot read', async () => {
    const id = await wedged(lease({ renewedAt: 'not a time' }));
    await reconciler.resetAutonomousWedgesOnce();
    expect(await statusOf(id)).toBe('open');
    const [body] = await commentsOn(id);
    expect(body).toContain('could not be read (renewedAt is not a parseable timestamp)');
  });

  it('is not held by an unexpired lease whose holder stopped beating', async () => {
    const silentSince = new Date(Date.now() - 10 * MINUTE).toISOString();
    const id = await wedged(lease({ heartbeat: { at: silentSince, everySeconds: 30 } }));
    await reconciler.resetAutonomousWedgesOnce();
    expect(await statusOf(id)).toBe('open');
    const [body] = await commentsOn(id);
    expect(body).toContain("its holder's heartbeat has been silent for");
  });

  it('keeps an issue whose lease was renewed after the pass chose it, and says nothing', async () => {
    const id = await wedged(lapsedLease());
    const reset = await whileRowIsHeld(
      id,
      (tx) =>
        tx.execute(sql`
          UPDATE issues SET session_context = ${JSON.stringify({ lease: liveLease() })}::jsonb
          WHERE id = ${id}
        `),
      () => reconciler.resetAutonomousWedgesOnce(),
    );
    expect(reset).toBe(0);
    expect(await statusOf(id)).toBe('in_progress');
    expect(await commentsOn(id)).toEqual([]);
  });
});

describe('a reset the wedge net makes is on the issue (ISS-1317)', () => {
  it('leaves one comment naming the reconciler, both statuses and the lapsed lease', async () => {
    const id = await wedged(lapsedLease());
    await reconciler.resetAutonomousWedgesOnce();
    const bodies = await commentsOn(id);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('**Moved by the reconciler: `in_progress` -> `open`**');
    expect(bodies[0]).toContain('not a person');
    expect(bodies[0]).toMatch(/the lease held by `iss-run-1` lapsed at \d{4}-\d\d-\d\dT/);
  });

  it('says no lease was held when the issue carries none', async () => {
    const id = await wedged(undefined);
    await reconciler.resetAutonomousWedgesOnce();
    expect(await statusOf(id)).toBe('open');
    const bodies = await commentsOn(id);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('no run held a lease on it');
  });

  it('leaves no comment when the status write is refused after the comment was drafted', async () => {
    const id = await wedged(lapsedLease());
    const reset = await whileRowIsHeld(
      id,
      async (tx) => {
        await tx.execute(sql`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`);
        await tx.execute(sql`UPDATE issues SET status = 'needs_info' WHERE id = ${id}`);
      },
      () => reconciler.resetAutonomousWedgesOnce(),
    );
    expect(reset).toBe(0);
    expect(await statusOf(id)).toBe('needs_info');
    expect(await commentsOn(id)).toEqual([]);
  });
});

describe('lease-held candidates do not use up the pass (ISS-1317)', () => {
  it('reaches a real wedge behind more lease-held candidates than one page holds', async () => {
    const held = 201;
    for (let n = 0; n < held; n++) {
      await wedged(liveLease(), `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
    }
    const id = await wedged(lapsedLease(), 'ffffffff-ffff-4fff-bfff-ffffffffffff');

    expect(await reconciler.resetAutonomousWedgesOnce()).toBe(1);
    expect(await statusOf(id)).toBe('open');
    const rows = await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM issues WHERE status = 'in_progress'`,
    );
    expect((rows[0] as { n: number }).n).toBe(held);
  });
});
