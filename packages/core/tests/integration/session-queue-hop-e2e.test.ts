/**
 * ISS-1101 — the queue hop's two arms, against real Postgres.
 *
 * `loop-monitor.test.ts` mocks `db.update()` and captures the `where` as an
 * opaque drizzle object; `sqlText` flattens it to its literals and a column
 * reference renders as nothing at all, so an arm reading the wrong column — or
 * the wrong sense of the right one — passes there unchanged. That lane can see
 * the four reasons and nothing else, which is all it now claims.
 *
 * Three directions matter. A session nothing has ever reported on is the one
 * `queue_timeout` is true of. One a worker claimed and reported on is not, at
 * any age, while it is still reporting. And the one that reported and then went
 * quiet is neither — it is `turn_never_reported`, named for what core observed
 * rather than for what it usually means, because core sees reports and never
 * the pane.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ws/broadcast.js', () => ({
  broadcast: vi.fn(),
  broadcastToProject: vi.fn(),
}));

const emitWedge = vi.fn(async (_input: unknown) => undefined);
vi.mock('../../src/pipeline/wedge.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, emitPipelineWedge: (input: unknown) => emitWedge(input) };
});

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
let alarmZombieSessions: typeof import('../../src/pipeline/sweeper.js').alarmZombieSessions;
let getLoopThresholds: typeof import('../../src/jobs/loop-monitor.js').getLoopThresholds;
let ownerId: string;
let deviceId: string;
let deviceToken: string;
let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;

const NOW = new Date('2026-09-18T12:00:00.000Z');
/** `now` minus `ms`, as the ISO string a raw `sql` template can bind. */
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  ({ reapZombieSessions, getLoopThresholds } = await import('../../src/jobs/loop-monitor.js'));
  ({ alarmZombieSessions } = await import('../../src/pipeline/sweeper.js'));
  const { jobLifecycleDeviceRoutes } = await import('../../src/jobs/lifecycle-routes.js');
  const { jobEventsRoutes } = await import('../../src/jobs/events-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono();
  app.use('*', requestId());
  app.route('/api/jobs', jobEventsRoutes as never);
  app.route('/api/jobs', jobLifecycleDeviceRoutes as never);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  emitWedge.mockClear();
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({ ownerId, name: 'd1', platform: 'linux' });
  deviceId = issued.device.id;
  deviceToken = issued.plaintext;
});

/** A `queued` pipeline session dispatched `dispatchedAgo` ago, last heard from
 *  `heardAgo` ago — `null` for a session nothing has ever reported on. */
async function queuedSession(opts: {
  dispatchedAgo: number;
  heardAgo: number | null;
}): Promise<string> {
  const id = randomUUID();
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    VALUES (${runId}, ${projectId}, 'interactive', 'running', ${ago(opts.dispatchedAgo)}::timestamptz)
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions
      (id, project_id, pipeline_run_id, status, metadata, dispatched_at, last_heartbeat_at,
       created_at, updated_at)
    VALUES (${id}, ${projectId}, ${runId}, 'queued',
            ${JSON.stringify({ type: 'pipeline' })}::jsonb,
            ${ago(opts.dispatchedAgo)}::timestamptz,
            ${opts.heardAgo === null ? null : ago(opts.heardAgo)}::timestamptz,
            ${ago(opts.dispatchedAgo)}::timestamptz, ${ago(opts.dispatchedAgo)}::timestamptz)
  `);
  return id;
}

async function statusOf(id: string): Promise<{ status: string; reason: string | null }> {
  const rows = await harness.db.execute<{ status: string; failure_reason: string | null }>(
    sql`SELECT status, failure_reason FROM agent_sessions WHERE id = ${id}`,
  );
  const row = rows[0];
  return { status: row?.status ?? 'gone', reason: row?.failure_reason ?? null };
}

const QUEUE = () => getLoopThresholds().queueMs;
const QUIET = () => getLoopThresholds().heartbeatMs;

describe('the queue hop, split on whether anything ever reported', () => {
  // cm:guard the arm whose wedge sentence — "no worker claimed the session within the queue
  // timeout" — is only true of THIS row. It is the one that must keep firing unchanged.
  it('fails a session nothing has ever reported on with queue_timeout', async () => {
    const id = await queuedSession({ dispatchedAgo: QUEUE() + 1_000, heardAgo: null });

    await reapZombieSessions(NOW);

    expect(await statusOf(id)).toEqual({ status: 'failed', reason: 'queue_timeout' });
  });

  // cm:guard THE false positive this change exists to prevent, and the whole reason the queue
  // predicate had to grow an activity term: until now the status flip was serving as one, and
  // narrowing that flip took it away. A worker holding a pane with a pasted prompt beats every tick
  // and does not move `dispatched_at` by a millisecond.
  it('leaves a session alone while it is still reporting, however old its dispatch', async () => {
    const id = await queuedSession({ dispatchedAgo: QUEUE() * 10, heardAgo: 1_000 });

    await reapZombieSessions(NOW);

    expect(await statusOf(id)).toEqual({ status: 'queued', reason: null });
  });

  // cm:guard the second arm, and the reason it is not `queue_timeout`: a worker DID claim this one.
  it('fails a session that reported and then went quiet with turn_never_reported', async () => {
    const id = await queuedSession({ dispatchedAgo: QUIET() * 2, heardAgo: QUIET() + 1_000 });

    await reapZombieSessions(NOW);

    expect(await statusOf(id)).toEqual({ status: 'failed', reason: 'turn_never_reported' });
  });

  // cm:guard the rule stated as a rule rather than as one row: no session core has ever heard from
  // may carry the reason that says nobody picked it up. A single predicate over both arms passes
  // every other test in this file and fails this one.
  it('never writes queue_timeout on a session that carries a heartbeat', async () => {
    const heard = [1_000, QUEUE() + 1_000, QUIET() + 1_000, QUIET() * 100];
    const ids = await Promise.all(
      heard.map((heardAgo) => queuedSession({ dispatchedAgo: QUIET() * 200, heardAgo })),
    );

    await reapZombieSessions(NOW);

    const reasons = await Promise.all(ids.map(async (id) => (await statusOf(id)).reason));
    expect(reasons).not.toContain('queue_timeout');
  });

  // cm:guard the boundary, both sides of it in one test — a cutoff asserted from one side only
  // passes just as well when the comparison is inclusive as when it is not.
  it('spares a session exactly on the quiet cutoff and fails one a millisecond past it', async () => {
    const onIt = await queuedSession({ dispatchedAgo: QUIET() * 2, heardAgo: QUIET() });
    const pastIt = await queuedSession({ dispatchedAgo: QUIET() * 2, heardAgo: QUIET() + 1 });

    await reapZombieSessions(NOW);

    expect((await statusOf(onIt)).status).toBe('queued');
    expect((await statusOf(pastIt)).status).toBe('failed');
  });

  // cm:guard both arms in ONE sweep, because a fix that split the predicate but left the first arm
  // matching everything would still pass each single-row test above.
  it('separates the two in one sweep rather than taking the batch one way', async () => {
    const neverHeard = await queuedSession({ dispatchedAgo: QUEUE() * 3, heardAgo: null });
    const heardThenQuiet = await queuedSession({
      dispatchedAgo: QUEUE() * 3,
      heardAgo: QUIET() + 1,
    });
    const beating = await queuedSession({ dispatchedAgo: QUEUE() * 3, heardAgo: 500 });

    const result = await reapZombieSessions(NOW);

    expect((await statusOf(neverHeard)).reason).toBe('queue_timeout');
    expect((await statusOf(heardThenQuiet)).reason).toBe('turn_never_reported');
    expect(await statusOf(beating)).toEqual({ status: 'queued', reason: null });
    expect(result.queueTimedOut).toBe(1);
    expect(result.turnNeverReported).toBe(1);
  });

  // cm:guard the sentence an operator reads. `queue_timeout`'s wedge tells them to check the fleet
  // for an online runner, which is false and wasted advice about a row a runner is plainly holding.
  it('writes a wedge that names the silence and not an unclaimed session', async () => {
    await queuedSession({ dispatchedAgo: QUIET() * 2, heardAgo: QUIET() + 1_000 });

    await reapZombieSessions(NOW);

    const wedges = emitWedge.mock.calls.map((c) => c[0] as { reason: string; hop: string });
    expect(wedges).toHaveLength(1);
    expect(wedges[0]?.reason).toBe(
      'the session stopped reporting before anything reported a turn beginning',
    );
    expect(wedges[0]?.hop).toBe('heartbeat');
  });

  // cm:guard the reason names what core OBSERVED. Core cannot see the pane, so a cause asserting
  // the agent never started would be the same over-assertion `events-routes.ts` was just stopped
  // from making, one column over — and it would be false whenever the reports were simply lost.
  it('does not claim the agent never started, only that nothing reported a turn', async () => {
    await queuedSession({ dispatchedAgo: QUIET() * 2, heardAgo: QUIET() + 1_000 });

    await reapZombieSessions(NOW);

    const wedges = emitWedge.mock.calls.map((c) => c[0] as { reason: string });
    expect(wedges).toHaveLength(1);
    expect(wedges[0]?.reason).not.toMatch(/never (started|asked|submitted)/i);
    expect(wedges[0]?.reason).not.toMatch(/no worker claimed/i);
  });

  // cm:guard the scoping the split must not have dropped: both arms are pipeline/pm only, and a
  // chat session queued for a week is nobody's to fail here.
  it('leaves a non-pipeline session out of both arms', async () => {
    const id = randomUUID();
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${projectId}, 'interactive', 'running')
    `);
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status, metadata, dispatched_at, last_heartbeat_at)
      VALUES (${id}, ${projectId}, ${runId}, 'queued', ${JSON.stringify({ agentChat: {} })}::jsonb,
              ${ago(QUIET() * 100)}::timestamptz, ${ago(QUIET() * 100)}::timestamptz)
    `);

    await reapZombieSessions(NOW);

    expect((await statusOf(id)).status).toBe('queued');
  });
});

describe('the demoted alarm mirrors both arms', () => {
  // cm:guard the mirror exists to say "the loop missed a row this tick". Matching rows the loop
  // deliberately leaves alone turns a coverage proof into a minute-by-minute false alarm, which is
  // the failure mode nobody notices because the alarm is only a log line.
  it('alarms nothing while a queued session is still reporting', async () => {
    await queuedSession({ dispatchedAgo: QUEUE() * 10, heardAgo: 1_000 });

    const result = await alarmZombieSessions(NOW, {});

    expect(result.queueTimedOut).toBe(0);
    expect(result.turnNeverReported).toBe(0);
  });

  // cm:guard the mirror against the LOOP, not against a re-reading of the same intent: the counts
  // are compared row for row over one snapshot, which is the only assertion that catches the two
  // drifting apart.
  it('counts exactly what the loop would fail, on both arms', async () => {
    await queuedSession({ dispatchedAgo: QUEUE() * 3, heardAgo: null });
    await queuedSession({ dispatchedAgo: QUEUE() * 3, heardAgo: QUIET() + 1 });
    await queuedSession({ dispatchedAgo: QUEUE() * 3, heardAgo: 500 });

    const alarmed = await alarmZombieSessions(NOW, {});
    const reaped = await reapZombieSessions(NOW);

    expect(alarmed.queueTimedOut).toBe(reaped.queueTimedOut);
    expect(alarmed.turnNeverReported).toBe(reaped.turnNeverReported);
    expect(alarmed.queueTimedOut).toBe(1);
    expect(alarmed.turnNeverReported).toBe(1);
  });
});

/*
 * ISS-1101 — where core and the box both speak, they say the same thing.
 *
 * The plan's race argument rests on this and not on a deterministic winner.
 * Core's arm needs the box to be SILENT, so on a box whose reports are arriving
 * only the box speaks. Where both do — a live box whose reports stopped reaching
 * core — the order is genuinely a coin-flip, and the issue's complaint was that
 * "the failure reason on the record would vary run to run". It does not vary,
 * because the two name one member.
 */
describe('core and the box agree on the reason, in either order', () => {
  // cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/daemon/turn_evidence.rs — `never_started_reason`, pasted whole. A reword there and not in `failure-patterns.ts` drops this to `unclassified` and this test is what says so.
  const BOX_SAYS =
    "the job's pane `forge-job-3d93cbab` was opened and its prompt delivered, but the agent " +
    'never reported submitting it, or anything else, in 120s — tmux accepted the keystroke and ' +
    'no turn ever began, so this box never had work in flight to report';

  /** A queued, quiet pipeline session with a live job dispatched to this device. */
  async function sessionWithJob(heardAgo: number): Promise<{ sessionId: string; jobId: string }> {
    const sessionId = await queuedSession({ dispatchedAgo: QUIET() * 2, heardAgo });
    const jobId = randomUUID();
    const runRows = await harness.db.execute<{ pipeline_run_id: string }>(
      sql`SELECT pipeline_run_id FROM agent_sessions WHERE id = ${sessionId}`,
    );
    const runId = runRows[0]?.pipeline_run_id;
    await harness.db.execute(sql`
      UPDATE agent_sessions SET device_id = ${deviceId} WHERE id = ${sessionId}
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, agent_session_id, device_id, created_by,
                        type, status, acked_at, payload)
      VALUES (${jobId}, ${projectId}, ${runId}, ${sessionId}, ${deviceId}, ${ownerId}, 'code',
              'running', now(), '{}'::jsonb)
    `);
    return { sessionId, jobId };
  }

  async function boxFails(jobId: string): Promise<Response> {
    return app.request(`/api/jobs/${jobId}/fail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ error: BOX_SAYS }),
    });
  }

  it('reads turn_never_reported when the box reports first and core never gets to reap', async () => {
    const { sessionId, jobId } = await sessionWithJob(QUIET() + 1_000);

    expect((await boxFails(jobId)).status).toBe(200);
    const result = await reapZombieSessions(NOW);

    expect(await statusOf(sessionId)).toEqual({
      status: 'failed',
      reason: 'turn_never_reported',
    });
    // cm:guard the session left `queued` on the box's report, so core's arm had nothing to match —
    // which is the half of the argument that does not depend on the two agreeing.
    expect(result.turnNeverReported).toBe(0);
  });

  it('reads turn_never_reported when core reaps first and the box reports afterwards', async () => {
    const { sessionId, jobId } = await sessionWithJob(QUIET() + 1_000);

    const result = await reapZombieSessions(NOW);
    expect(result.turnNeverReported).toBe(1);
    expect((await boxFails(jobId)).status).toBe(200);

    expect(await statusOf(sessionId)).toEqual({
      status: 'failed',
      reason: 'turn_never_reported',
    });
  });
});

/*
 * ISS-1101 — the two halves composed, on the one scenario the issue names.
 *
 * Everything above tests one half: the ingest file plants frames and reads the
 * row, this file plants rows and runs the reaper. Neither can fail on the claim
 * that actually matters — that a box beating `starting` every tick is neither
 * read as running NOR failed, however long its first turn takes. That claim
 * spans both, so it is asserted across both, through the real route and the
 * real reaper, with the real `getLoopThresholds` numbers and no stub between.
 */
describe('a box that keeps saying `starting` is neither flipped nor failed', () => {
  /** What `Evidence::Delivered` and `Evidence::NeverStarted` beat (`turn_evidence.rs`). */
  const starting = { kind: 'progress', data: { source: 'pool_jobs', runtimeState: 'starting' } };

  async function beat(jobId: string, events: unknown[]): Promise<Response> {
    return app.request(`/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });
  }

  async function seedWithJob(dispatchedAgo: number): Promise<{ sessionId: string; jobId: string }> {
    const sessionId = await queuedSession({ dispatchedAgo, heardAgo: null });
    const runRows = await harness.db.execute<{ pipeline_run_id: string }>(
      sql`SELECT pipeline_run_id FROM agent_sessions WHERE id = ${sessionId}`,
    );
    const jobId = randomUUID();
    await harness.db.execute(sql`
      UPDATE agent_sessions SET device_id = ${deviceId} WHERE id = ${sessionId}
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, agent_session_id, device_id, created_by,
                        type, status, acked_at, payload)
      VALUES (${jobId}, ${projectId}, ${runRows[0]?.pipeline_run_id}, ${sessionId}, ${deviceId},
              ${ownerId}, 'code', 'running', now(), '{}'::jsonb)
    `);
    return { sessionId, jobId };
  }

  async function rowOf(
    id: string,
  ): Promise<{ status: string; reason: string | null; state: string | null }> {
    const rows = await harness.db.execute<{
      status: string;
      failure_reason: string | null;
      runtime_state: string | null;
    }>(sql`SELECT status, failure_reason, runtime_state FROM agent_sessions WHERE id = ${id}`);
    const r = rows[0];
    return {
      status: r?.status ?? 'gone',
      reason: r?.failure_reason ?? null,
      state: r?.runtime_state ?? null,
    };
  }

  // cm:guard THE case the issue names, and it needs BOTH halves to pass: the flip must not happen
  // (`events-routes.ts`) and the queue arm must not fire on the row that leaves (`queue-hop.ts`).
  // The dispatch age is ten times the queue threshold and the beats run past it, which is what makes
  // this a statement about the two clocks rather than about one tick.
  it('is still queued, and unfailed, after beating past ten times the queue threshold', async () => {
    const { sessionId, jobId } = await seedWithJob(QUEUE() * 10);

    // Four beats spread across the whole window the old queue arm would have fired inside.
    for (let i = 0; i < 4; i++) {
      expect((await beat(jobId, [starting])).status).toBe(200);
    }
    expect(await rowOf(sessionId)).toEqual({
      status: 'queued',
      reason: null,
      state: 'starting',
    });

    await reapZombieSessions(NOW);

    expect(await rowOf(sessionId)).toEqual({
      status: 'queued',
      reason: null,
      state: 'starting',
    });
  });

  // cm:guard the other direction on the same row: once the beats STOP it is bounded, and by the
  // reason that is true of it. Without this the case above is only half a claim — "never failed" and
  // "never failed for the right reason" are different, and a row nothing ever reaps is the wedged
  // session `VISION: state-never-lies` forbids just as much as a row reaped wrongly.
  it('is failed as turn_never_reported once the beats stop, never as queue_timeout', async () => {
    const { sessionId, jobId } = await seedWithJob(QUEUE() * 10);
    expect((await beat(jobId, [starting])).status).toBe(200);

    // The box goes silent: its last report ages past the quiet cutoff.
    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = ${ago(QUIET() + 1_000)}::timestamptz
      WHERE id = ${sessionId}
    `);
    await reapZombieSessions(NOW);

    const after = await rowOf(sessionId);
    expect(after.status).toBe('failed');
    expect(after.reason).toBe('turn_never_reported');
  });

  // cm:guard the flip is not merely delayed — a turn REPORTED after all that silence still earns it,
  // and `started_at` is stamped then and not at dispatch. A rule that just refused `starting` for
  // ever would pass both cases above and leave every session queued for its whole life.
  it('flips the moment a turn is reported, however long the starting beats ran', async () => {
    const { sessionId, jobId } = await seedWithJob(QUEUE() * 10);
    for (let i = 0; i < 3; i++) {
      expect((await beat(jobId, [starting])).status).toBe(200);
    }
    expect((await rowOf(sessionId)).status).toBe('queued');

    expect(
      (await beat(jobId, [{ kind: 'progress', data: { runtimeState: 'working' } }])).status,
    ).toBe(200);

    expect(await rowOf(sessionId)).toMatchObject({ status: 'running', reason: null });
    const stamped = await harness.db.execute<{ started_at: string | null }>(
      sql`SELECT started_at::text AS started_at FROM agent_sessions WHERE id = ${sessionId}`,
    );
    expect(stamped[0]?.started_at).not.toBeNull();
  });
});
