/**
 * ISS-1190 — what an abort says about a roster its finish had partly closed, the paths the
 * release sentences send, a held roster across a sweeper pass, and `state` behind a probe that
 * never answers, against real Postgres, through the door, the real worker and the abort.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

const BEFORE = '1111111111111111111111111111111111111111';
const PUSHED = '2222222222222222222222222222222222222222';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let serving = BEFORE;
let hang = false;
let probe: Server;
let probeUrl: string;
let job: typeof import('../../src/release-batch/finish-job.js');
let service: typeof import('../../src/release-batch/service.js');
let refusals: typeof import('../../src/release-batch/refusals.js');

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  probe = createServer((_req, res) => {
    if (!hang) res.end(serving);
  });
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/version`;
  job = await import('../../src/release-batch/finish-job.js');
  service = await import('../../src/release-batch/service.js');
  refusals = await import('../../src/release-batch/refusals.js');
}, 120_000);

afterAll(async () => {
  probe.closeAllConnections();
  await new Promise<void>((done) => probe.close(() => done()));
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  serving = BEFORE;
  hang = false;
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  await fx.declareProduction();
  await fx.seedReleaseRunner();
  await harness.db.execute(sql`
    UPDATE integration_bindings
    SET config = config || ${JSON.stringify({
      verify: { probes: [{ url: probeUrl }], timeoutSeconds: 12, stableReads: 1 },
    })}::jsonb
    WHERE project_id = ${projectId} AND provider = 'coolify'
  `);
});

const actor = () => ({ type: 'user' as const, id: ownerId });

async function batchOf(n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) ids.push(await fx.insertIssue());
  const { runId } = await fx.claim(ids);
  return { runId, ids };
}

async function accept(runId: string) {
  return job.acceptReleaseBatchFinish(runId, actor(), { commit: PUSHED }, async () => {});
}

async function promoted(runId: string): Promise<void> {
  const { openAttempt } = await import('../../src/release-batch/ledger.js');
  await openAttempt({ runId, stage: 'promote', idempotencyKey: 'promote-1', commit: PUSHED });
}

async function abort(runId: string, options: Parameters<typeof service.abortReleaseBatch>[3] = {}) {
  return service.abortReleaseBatch(runId, 'a person stopped it', ownerId, options);
}

/** The refusal a finish call meets, as the REST door would answer it. */
async function refused(runId: string): Promise<{ message: string; details: unknown }> {
  try {
    await accept(runId);
  } catch (err) {
    const http = refusals.finishRefusal(err);
    if (!http) throw err;
    return { message: http.message, details: (http.cause as { details?: unknown }).details };
  }
  throw new Error('the finish was not refused');
}

/** The key a person knows this issue by, read off its own row and project. */
async function keyOf(issueId: string): Promise<string> {
  const rows = await harness.db.execute(sql`
    SELECT coalesce(p.issue_prefix, 'ISS') || '-' || i.iss_seq AS key
    FROM issues i JOIN projects p ON p.id = i.project_id WHERE i.id = ${issueId}
  `);
  return String(rows[0]?.key);
}

/** A key as a whole word, so ISS-1 is not found inside ISS-12. */
const named = (key: string) => new RegExp(`\\b${key}\\b`);

async function storedFinish(runId: string): Promise<Record<string, unknown> | null> {
  const rows = await harness.db.execute(sql`
    SELECT metadata -> 'finish' AS finish FROM pipeline_runs WHERE id = ${runId}
  `);
  return (rows[0]?.finish as Record<string, unknown> | null) ?? null;
}

async function promotionNote(issueId: string): Promise<string | undefined> {
  const rows = await harness.db.execute(sql`
    SELECT body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at
  `);
  return rows.map((r) => String(r.body)).find((b) => b.includes('recorded a promotion'));
}

/** Wait until some write in this database is blocked on a lock while updating `pipeline_runs`. */
async function untilARunWriteWaits(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const waiting = await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query ILIKE '%update%pipeline_runs%'
    `);
    if (Number(waiting[0]?.n ?? 0) > 0) return;
    await new Promise((d) => setTimeout(d, 20));
  }
  throw new Error('no write to pipeline_runs ever waited on the held row');
}

/**
 * Run the attempt green and abort inside the second close's fence: the abort's stamp waits on the
 * run row that fence holds, so the second close commits, and the third close's fence sees the
 * stamp and refuses. Two issues end closed and one does not.
 */
async function abortInsideSecondClose(
  runId: string,
  options: Parameters<typeof service.abortReleaseBatch>[3] = {},
) {
  serving = PUSHED;
  await accept(runId);
  let fences = 0;
  let aborting: ReturnType<typeof service.abortReleaseBatch> | null = null;
  await job.runReleaseBatchFinish(runId, {
    afterFence: async () => {
      fences += 1;
      if (fences !== 2) return;
      aborting = abort(runId, options);
      await untilARunWriteWaits();
    },
  });
  if (!aborting) throw new Error('the abort never started');
  return aborting as ReturnType<typeof service.abortReleaseBatch>;
}

async function split(ids: string[]): Promise<{ closed: string[]; open: string[] }> {
  const closed: string[] = [];
  const open: string[] = [];
  for (const id of ids) ((await fx.stored(id)).status === 'closed' ? closed : open).push(id);
  return { closed: closed.sort(), open };
}

describe('a batch aborted after its finish closed part of the roster', () => {
  it('says which issues closed and stay closed, and the abort names them apart', async () => {
    const { runId, ids } = await batchOf(3);
    const aborted = await abortInsideSecondClose(runId);
    const { closed, open } = await split(ids);
    expect(closed).toHaveLength(2);
    expect(open).toHaveLength(1);
    const [returned] = open as [string];
    expect((await fx.stored(returned)).status).toBe('awaiting_release');

    expect(await storedFinish(runId)).toMatchObject({
      state: 'failed',
      refusal: { code: 'RELEASE_BATCH_ABORTED' },
    });
    const answer = await refused(runId);
    expect(answer.message).not.toMatch(/its claims were released and its roster is back/);
    for (const id of closed) {
      expect(answer.message).toMatch(named(await keyOf(id)));
      expect(answer.message).not.toContain(id);
    }
    expect(answer.message).toMatch(/they stay closed/);
    expect(answer.message).not.toMatch(named(await keyOf(returned)));
    expect(answer.details).toEqual({ account: 'released', closed });

    expect([...aborted.alreadyClosed].sort()).toEqual(closed);
    expect(aborted.recovered).toEqual([returned]);
  }, 40_000);

  it('says the closed issues stay closed beside a held roster that stays at releasing', async () => {
    const { runId, ids } = await batchOf(3);
    await promoted(runId);
    const aborted = await abortInsideSecondClose(runId);
    const { closed, open } = await split(ids);
    expect(closed).toHaveLength(2);
    const [held] = open as [string];
    expect((await fx.stored(held)).status).toBe('releasing');

    expect([...aborted.alreadyClosed].sort()).toEqual(closed);
    expect(aborted.recovered).toEqual([]);

    const answer = await refused(runId);
    expect(answer.details).toEqual({ account: 'held', closed });
    for (const id of closed) {
      expect(answer.message).toMatch(named(await keyOf(id)));
      expect(answer.message).not.toContain(id);
    }
    expect(answer.message).toMatch(/they stay closed\. Every other issue stays at `releasing`/);
  }, 40_000);

  it('still names the closed issues after a second abort, whose recovery finds no claim', async () => {
    const { runId, ids } = await batchOf(3);
    await abortInsideSecondClose(runId);
    const { closed } = await split(ids);
    const again = await abort(runId);
    expect(again.alreadyClosed).toEqual([]);
    const answer = await refused(runId);
    expect(answer.details).toEqual({ account: 'released', closed });
    for (const id of closed) expect(answer.message).toMatch(named(await keyOf(id)));
  }, 40_000);

  it('names a closed issue no finish record holds when a second abort runs inside the first', async () => {
    const { runId, ids } = await batchOf(2);
    const [closedOne] = ids as [string, string];
    // A finish that closed one issue and died before it checkpointed: only the claim indexes it.
    await harness.db.execute(sql`UPDATE issues SET status = 'closed' WHERE id = ${closedOne}`);
    let inner: Awaited<ReturnType<typeof service.abortReleaseBatch>> | null = null;
    await abort(runId, {
      afterRosterRecovered: async () => {
        inner = await abort(runId);
      },
    });
    expect(inner).toMatchObject({ alreadyClosed: [] });
    const answer = await refused(runId);
    expect(answer.details).toEqual({ account: 'released', closed: [closedOne] });
    expect(answer.message).toMatch(named(await keyOf(closedOne)));
  }, 30_000);

  it('names the closed issues when the abort lands after the finish released every claim', async () => {
    const { runId, ids } = await batchOf(2);
    serving = PUSHED;
    await accept(runId);
    // Two closes, then the finish's own claim release: the abort waits on that write's run row,
    // and the release stamp that follows it refuses the stamped run.
    let fences = 0;
    let aborting: ReturnType<typeof service.abortReleaseBatch> | null = null;
    await job.runReleaseBatchFinish(runId, {
      afterFence: async () => {
        fences += 1;
        if (fences !== 3) return;
        aborting = abort(runId);
        await untilARunWriteWaits();
      },
    });
    if (!aborting) throw new Error('the abort never started');
    const aborted = await (aborting as ReturnType<typeof service.abortReleaseBatch>);
    expect(aborted.alreadyClosed).toEqual([]);
    for (const id of ids)
      expect(await fx.stored(id)).toMatchObject({ status: 'closed', claim: null });
    expect(await storedFinish(runId)).toMatchObject({ refusal: { code: 'RELEASE_BATCH_ABORTED' } });

    const answer = await refused(runId);
    expect(answer.details).toEqual({ account: 'released', closed: [...ids].sort() });
    expect(answer.message).not.toMatch(/its claims were released and its roster is back/);
  }, 40_000);

  it('keeps the whole-roster sentence when nothing had closed', async () => {
    const { runId, ids } = await batchOf(2);
    const aborted = await abort(runId);
    expect(aborted.alreadyClosed).toEqual([]);
    expect([...aborted.recovered].sort()).toEqual([...ids].sort());
    const answer = await refused(runId);
    expect(answer.details).toEqual({ account: 'released', closed: [] });
    expect(answer.message).toMatch(/its claims were released and its roster is back/);
  }, 30_000);
});

describe('the paths a promoted roster is told to read', () => {
  it('names the real project and run in the note a held roster is given', async () => {
    const { runId, ids } = await batchOf(1);
    await promoted(runId);
    await abort(runId);
    const note = await promotionNote(ids[0] as string);
    expect(note).toContain(`/api/projects/${projectId}/release-batches/${runId}/state`);
    expect(note).not.toMatch(/\{projectId\}|\{runId\}/);
  }, 30_000);

  it('names the real project in the note a settled roster is given', async () => {
    const { runId, ids } = await batchOf(1);
    await promoted(runId);
    await abort(runId, { promotedRoster: 'return-to-gate' });
    const note = await promotionNote(ids[0] as string);
    expect(note).toContain(`/api/projects/${projectId}/release-records`);
    expect(note).not.toMatch(/\{projectId\}|\{runId\}/);
  }, 30_000);
});

describe('a held promoted roster across a sweeper pass', () => {
  it('stays claimed, so a return-to-gate abort still puts it back at the gate', async () => {
    const { runId, ids } = await batchOf(2);
    await promoted(runId);
    await abort(runId);
    expect(await fx.runStatus(runId)).toBe('cancelled');

    const { reapStaleReleaseBatchClaims } = await import(
      '../../src/pipeline/stale-release-claims.js'
    );
    await reapStaleReleaseBatchClaims();
    for (const id of ids) expect((await fx.stored(id)).claim).toBe(runId);

    const settled = await abort(runId, { promotedRoster: 'return-to-gate' });
    expect([...settled.recovered].sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
    }
  }, 30_000);

  it('still clears every other stale claim of a run that ended', async () => {
    const { runId, ids } = await batchOf(2);
    await harness.db.execute(sql`UPDATE pipeline_runs SET status = 'failed' WHERE id = ${runId}`);
    const { reapStaleReleaseBatchClaims } = await import(
      '../../src/pipeline/stale-release-claims.js'
    );
    expect(await reapStaleReleaseBatchClaims()).toEqual({ released: 2 });
    for (const id of ids) expect((await fx.stored(id)).claim).toBeNull();
  }, 30_000);
});

describe('a finish on a run that announced no method', () => {
  it('names the real method path and the skill the run’s job names', async () => {
    const { runId } = await batchOf(1);
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET metadata = metadata - 'method' WHERE id = ${runId}
    `);
    await harness.db.execute(sql`
      UPDATE jobs SET payload = payload || '{"skillName":"house-release"}'::jsonb
      WHERE pipeline_run_id = ${runId} AND type = 'release_batch'
    `);
    const answer = await refused(runId);
    expect(answer.message).toContain(
      `POST /api/projects/${projectId}/release-batches/${runId}/method`,
    );
    expect(answer.message).toContain('"skill":"house-release"');
    expect(answer.message).not.toMatch(/\{projectId\}|\{runId\}/);
  }, 30_000);
});

describe('state read behind a probe that never answers', () => {
  it('answers the finish record and run status as they stand when the probe read ends', async () => {
    const { runId } = await batchOf(1);
    await accept(runId);
    hang = true;
    const { readReleaseRunState } = await import('../../src/release-batch/state.js');
    const reading = readReleaseRunState(runId);
    // The attempt ends and the run is cancelled while the probe holds the call.
    await new Promise((d) => setTimeout(d, 500));
    await harness.db.execute(sql`
      UPDATE pipeline_runs
      SET status = 'cancelled',
          metadata = jsonb_set(metadata, '{finish,state}', '"failed"'::jsonb)
      WHERE id = ${runId}
    `);
    const state = await reading;
    expect(state?.live?.health).toBe('down');
    expect(state?.runStatus).toBe('cancelled');
    expect(state?.finish?.state).toBe('failed');
  }, 30_000);
});

describe('the route a held promoted roster is told to take, followed in its order', () => {
  async function heldBatch() {
    const { runId, ids } = await batchOf(2);
    await promoted(runId);
    await abort(runId);
    for (const id of ids) expect(await fx.stored(id)).toMatchObject({ status: 'releasing' });
    return { runId, ids };
  }

  async function recordRelease(ids: string[]) {
    const { recordPerformedRelease } = await import('../../src/release-batch/recorded.js');
    return recordPerformedRelease({
      projectId,
      userId: ownerId,
      issueIds: ids,
      commit: serving,
      account: 'Promoted by the batch before it was aborted; production serves this commit.',
    });
  }

  it('names the return-to-gate abort before release-records, which is refused until it has run', async () => {
    const { ids, runId } = await heldBatch();
    const { message } = await refused(runId);
    const abortAt = message.indexOf('"return-to-gate"');
    const recordAt = message.indexOf(`POST /api/projects/${projectId}/release-records`);
    expect(abortAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(abortAt);
    expect(message).not.toMatch(/release-records, or abort/);

    serving = PUSHED;
    const { ClaimConflictError } = await import('../../src/release-batch/errors.js');
    await expect(recordRelease(ids)).rejects.toBeInstanceOf(ClaimConflictError);
  }, 30_000);

  it('closes the held roster when the refusal’s route is taken in its order', async () => {
    const { ids, runId } = await heldBatch();
    serving = PUSHED;
    await abort(runId, { promotedRoster: 'return-to-gate' });
    await recordRelease(ids);
    for (const id of ids) expect((await fx.stored(id)).status).toBe('closed');
  }, 30_000);

  it('gives the held note no finish, and the abort then release-records as its route', async () => {
    const { ids, runId } = await heldBatch();
    const note = (await promotionNote(ids[0] as string)) ?? '';
    expect(note).not.toMatch(/finish/i);
    const abortAt = note.indexOf(`POST /api/projects/${projectId}/release-batches/${runId}/abort`);
    const recordAt = note.indexOf(`POST /api/projects/${projectId}/release-records`);
    expect(abortAt).toBeGreaterThan(-1);
    expect(note.indexOf('"return-to-gate"')).toBeGreaterThan(abortAt);
    expect(recordAt).toBeGreaterThan(abortAt);
  }, 30_000);
});

describe('a finish naming no commit on a batch that recorded nothing serving when it opened', () => {
  async function blindBatch() {
    // A probe answering with no commit leaves the batch's `commitBefore` null.
    serving = '';
    const { runId, ids } = await batchOf(1);
    const rows = await harness.db.execute(sql`
      SELECT metadata -> 'commitBefore' AS before FROM pipeline_runs WHERE id = ${runId}
    `);
    expect(rows[0]?.before ?? null).toBeNull();
    // Production still serves the build it served before anything moved.
    serving = BEFORE;
    return { runId, ids };
  }

  it('is refused at the door, telling the caller to send commit, with no attempt recorded', async () => {
    const { runId } = await blindBatch();
    let caught: unknown = null;
    try {
      await job.acceptReleaseBatchFinish(runId, actor(), {}, async () => {});
    } catch (err) {
      caught = err;
    }
    const http = refusals.finishRefusal(caught);
    expect((http?.cause as { code?: string } | undefined)?.code).toBe('RELEASE_NOT_VERIFIED');
    expect(http?.message).toMatch(/`commit`/);
    expect(await storedFinish(runId)).toBeNull();
  }, 30_000);

  it('never closes the roster from a claimless attempt already standing', async () => {
    const { runId, ids } = await blindBatch();
    // An attempt accepted before the door refused this shape.
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET metadata = metadata || ${JSON.stringify({
        finish: {
          requestId: '00000000-0000-4000-8000-000000000001',
          state: 'accepted',
          commit: null,
          requestedBy: actor(),
          acceptedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1,
          owner: null,
          leaseUntil: null,
          workerStarts: 0,
          closed: null,
          failed: null,
          refusal: null,
          finishedAt: null,
        },
      })}::jsonb WHERE id = ${runId}
    `);
    await job.runReleaseBatchFinish(runId);
    expect(await storedFinish(runId)).toMatchObject({
      state: 'failed',
      refusal: { code: 'RELEASE_NOT_VERIFIED' },
    });
    expect((await fx.stored(ids[0] as string)).status).toBe('releasing');
  }, 30_000);
});
