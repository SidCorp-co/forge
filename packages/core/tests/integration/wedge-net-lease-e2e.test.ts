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
let outbox: typeof import('../../src/pipeline/outbox-worker.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  reconciler = await import('../../src/pipeline/reconciler.js');
  outbox = await import('../../src/pipeline/outbox-worker.js');
  const { hooks } = await import('../../src/pipeline/hooks.js');
  const { registerActivitySubscribers } = await import('../../src/pipeline/subscribers.js');
  registerActivitySubscribers(hooks);
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

/** Write the lease where it lives (ISS-54): the issue's work state, never `session_context`. */
function setLease(
  executor: Pick<typeof harness.db, 'execute'>,
  id: string,
  value: unknown,
): Promise<unknown> {
  return executor.execute(sql`
    INSERT INTO issue_work_state (issue_id, lease)
    VALUES (${id}, ${JSON.stringify(value)}::text::jsonb)
    ON CONFLICT (issue_id) DO UPDATE SET lease = EXCLUDED.lease, updated_at = now()
  `);
}

/** An `in_progress` issue whose latest job is a `done` `drive` job, whose issue run has ended and
 *  which nothing has written for two days — every term of the wedge read but the lease. */
async function wedged(sessionLease: unknown, id: string = randomUUID()): Promise<string> {
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, assignee_id,
                        session_context, updated_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'in_progress', ${ownerId}, ${ownerId},
            '{}'::jsonb, now() - interval '2 days')
  `);
  if (sessionLease !== undefined) await setLease(harness.db, id, sessionLease);
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

/** Every agent account, organization member and project member row an agent holds. */
async function agentFootprint(): Promise<{
  users: number;
  orgMembers: number;
  projectMembers: number;
}> {
  const [row] = (await harness.db.execute(sql`
    SELECT (SELECT count(*)::int FROM users WHERE kind = 'agent') AS users,
           (SELECT count(*)::int FROM organization_members m JOIN users u ON u.id = m.user_id
             WHERE u.kind = 'agent') AS "orgMembers",
           (SELECT count(*)::int FROM project_members m JOIN users u ON u.id = m.user_id
             WHERE u.kind = 'agent') AS "projectMembers"
  `)) as unknown as Array<{ users: number; orgMembers: number; projectMembers: number }>;
  return row as { users: number; orgMembers: number; projectMembers: number };
}

const NO_AGENT = { users: 0, orgMembers: 0, projectMembers: 0 };

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

    await setLease(harness.db, id, lapsedLease());
    await harness.db.execute(
      sql`UPDATE issues SET updated_at = now() - interval '2 days' WHERE id = ${id}`,
    );
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
    expect(body).toContain('past the 90s it tolerates');
  });

  it('keeps an issue whose lease was renewed after the pass chose it, and says nothing', async () => {
    const id = await wedged(lapsedLease());
    const reset = await whileRowIsHeld(
      id,
      (tx) => setLease(tx, id, liveLease()),
      () => reconciler.resetAutonomousWedgesOnce(),
    );
    expect(reset).toBe(0);
    expect(await statusOf(id)).toBe('in_progress');
    expect(await commentsOn(id)).toEqual([]);
    expect(await agentFootprint()).toEqual(NO_AGENT);
  });

  it('keeps an issue a person was asked about after the pass chose it, and mints nobody', async () => {
    const id = await wedged(lapsedLease());
    const reset = await whileRowIsHeld(
      id,
      (tx) =>
        tx.execute(sql`
          INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
          VALUES (${randomUUID()}, ${projectId}, ${id}, 'open', 'human', '[{"round":1}]'::jsonb)
        `),
      () => reconciler.resetAutonomousWedgesOnce(),
    );
    expect(reset).toBe(0);
    expect(await statusOf(id)).toBe('in_progress');
    expect(await commentsOn(id)).toEqual([]);
    expect(await agentFootprint()).toEqual(NO_AGENT);
  });

  it('calls a reset off when another writer minted the agent account after the pass read none', async () => {
    const { resolveProjectHandle } = await import('../../src/conversations/handles.js');
    const id = await wedged(lapsedLease());
    const reset = await whileRowIsHeld(
      id,
      (tx) => resolveProjectHandle(tx as never, projectId),
      () => reconciler.resetAutonomousWedgesOnce(),
    );
    expect(reset).toBe(0);
    expect(await statusOf(id)).toBe('in_progress');
    expect(await commentsOn(id)).toEqual([]);
    expect(await agentFootprint()).toEqual({ users: 1, orgMembers: 1, projectMembers: 1 });
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
        await tx.execute(
          sql`UPDATE issues SET status = 'needs_info', waiting_kind = 'needs_answer' WHERE id = ${id}`,
        );
      },
      () => reconciler.resetAutonomousWedgesOnce(),
    );
    expect(reset).toBe(0);
    expect(await statusOf(id)).toBe('needs_info');
    expect(await commentsOn(id)).toEqual([]);
  });
});

/** Who the reset's comment, kernel transition and activity row name, and when each says it was. */
async function resetTrail(id: string) {
  await outbox.drainOutboxOnce();
  const [comment] = (await harness.db.execute(sql`
    SELECT c.author_id, c.created_at, u.kind,
           EXISTS (SELECT 1 FROM project_members m
                   WHERE m.user_id = c.author_id AND m.project_id = ${projectId}) AS member
    FROM comments c JOIN users u ON u.id = c.author_id WHERE c.issue_id = ${id}
  `)) as unknown as Array<{ author_id: string; created_at: string; kind: string; member: boolean }>;
  const kernel = (await harness.db.execute(sql`
    SELECT actor_type, actor_id, actor_agency FROM kernel_transitions
    WHERE entity = 'issue' AND entity_id = ${id} AND to_status = 'open'
  `)) as unknown as Array<{ actor_type: string; actor_id: string; actor_agency: string }>;
  const activity = (await harness.db.execute(sql`
    SELECT actor_type, actor_id, actor_agency, created_at FROM activity_log
    WHERE issue_id = ${id} AND action = 'issue.statusChanged'
  `)) as unknown as Array<{
    actor_type: string;
    actor_id: string;
    actor_agency: string;
    created_at: string;
  }>;
  return { comment, kernel, activity };
}

describe('the reconciler is the one named on a reset (ISS-1317 r4)', () => {
  it('authors the reset comment as an agent account of the project, never the creator', async () => {
    const id = await wedged(lapsedLease());
    await reconciler.resetAutonomousWedgesOnce();
    const { comment } = await resetTrail(id);
    expect(comment?.kind).toBe('agent');
    expect(comment?.author_id).not.toBe(ownerId);
    expect(comment?.member).toBe(true);
  });

  it('shows the account it minted under its handle, never under a made-up address', async () => {
    const { resolveActors } = await import('../../src/issues/actor-resolution.js');
    const { actorKey } = await import('../../src/issues/actor-identity.js');
    const id = await wedged(lapsedLease());
    await reconciler.resetAutonomousWedgesOnce();
    const authorId = String((await resetTrail(id)).comment?.author_id);
    const [membership] = (await harness.db.execute(
      sql`SELECT handle FROM organization_members WHERE user_id = ${authorId}`,
    )) as unknown as Array<{ handle: string }>;
    const shown = (await resolveActors([{ type: 'user', id: authorId }])).get(
      actorKey('user', authorId),
    );
    expect(membership?.handle).toMatch(/^[a-z0-9-]+$/);
    expect(shown?.displayName).toBe(membership?.handle);
    expect(shown?.displayName).not.toMatch(/@agents\.forge\.invalid$/);
    expect(shown?.isAgent).toBe(true);
  });

  it('records the move in kernel_transitions and activity under that agent, as an agent', async () => {
    const id = await wedged(lapsedLease());
    await reconciler.resetAutonomousWedgesOnce();
    const { comment, kernel, activity } = await resetTrail(id);
    expect(kernel).toEqual([
      { actor_type: 'user', actor_id: comment?.author_id, actor_agency: 'agent' },
    ]);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      actor_type: 'user',
      actor_id: comment?.author_id,
      actor_agency: 'agent',
    });
  });

  it('stamps the status change with the time of the comment, not of the drain', async () => {
    const id = await wedged(lapsedLease());
    await reconciler.resetAutonomousWedgesOnce();
    await new Promise((r) => setTimeout(r, 50));
    const { comment, activity } = await resetTrail(id);
    const at = (t: unknown) => new Date(String(t)).getTime();
    expect(at(activity[0]?.created_at)).toBe(at(comment?.created_at));
  });

  it("authors as the project's existing handle where it already has one", async () => {
    const { resolveProjectHandle } = await import('../../src/conversations/handles.js');
    const { db } = await import('../../src/db/client.js');
    const handle = await db.transaction((tx) => resolveProjectHandle(tx, projectId));
    const id = await wedged(lapsedLease());
    await reconciler.resetAutonomousWedgesOnce();
    expect((await resetTrail(id)).comment?.author_id).toBe(handle.userId);
  });

  it('reuses one agent account across resets of the same project', async () => {
    const first = await wedged(lapsedLease());
    const second = await wedged(undefined);
    expect(await reconciler.resetAutonomousWedgesOnce()).toBe(2);
    const a = (await resetTrail(first)).comment;
    const b = (await resetTrail(second)).comment;
    expect(a?.author_id).toBe(b?.author_id);
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
