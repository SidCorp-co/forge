/**
 * ISS-1190 — a batch aborted while its finish attempt works reads as aborted
 * afterwards, against real Postgres.
 *
 * The abort goes through `abortReleaseBatch` and the attempt through the door and
 * the worker, so what is measured is the worker seeing the abort, not a planted
 * state standing in for it.
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
let probe: Server;
let probeUrl: string;
let job: typeof import('../../src/release-batch/finish-job.js');
let service: typeof import('../../src/release-batch/service.js');

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
  probe = createServer((_req, res) => res.end(serving));
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/version`;
  job = await import('../../src/release-batch/finish-job.js');
  service = await import('../../src/release-batch/service.js');
}, 120_000);

afterAll(async () => {
  await new Promise<void>((done) => probe.close(() => done()));
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  serving = BEFORE;
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

async function twoIssueBatch() {
  const first = await fx.insertIssue();
  const second = await fx.insertIssue();
  const { runId } = await fx.claim([first, second]);
  return { runId, issueIds: [first, second] };
}

async function accept(runId: string, commit?: string) {
  return job.acceptReleaseBatchFinish(runId, actor(), commit ? { commit } : {}, async () => {});
}

async function abort(runId: string, options: Parameters<typeof service.abortReleaseBatch>[3] = {}) {
  return service.abortReleaseBatch(runId, 'a person stopped it', ownerId, options);
}

async function stored(runId: string): Promise<Record<string, unknown> | null> {
  const rows = await harness.db.execute(sql`
    SELECT metadata -> 'finish' AS finish FROM pipeline_runs WHERE id = ${runId}
  `);
  return (rows[0]?.finish as Record<string, unknown> | null) ?? null;
}

async function shipped(runId: string): Promise<unknown> {
  const rows = await harness.db.execute(sql`
    SELECT release_released_at FROM pipeline_runs WHERE id = ${runId}
  `);
  return rows[0]?.release_released_at ?? null;
}

async function closesOf(issueId: string): Promise<number> {
  const rows = await harness.db.execute(sql`
    SELECT count(*)::int AS n FROM kernel_transitions
    WHERE entity = 'issue' AND entity_id = ${issueId} AND to_status = 'closed'
  `);
  return Number(rows[0]?.n ?? 0);
}

/** The code a finish call is refused with, or `null` when it answered. */
async function refusalCode(call: () => Promise<unknown>): Promise<string | null> {
  const { finishRefusal } = await import('../../src/release-batch/refusals.js');
  try {
    await call();
    return null;
  } catch (err) {
    const http = finishRefusal(err);
    return (http?.cause as { code?: string } | undefined)?.code ?? String(err);
  }
}

async function refusalMessage(call: () => Promise<unknown>): Promise<string | null> {
  const { finishRefusal } = await import('../../src/release-batch/refusals.js');
  try {
    await call();
    return null;
  } catch (err) {
    return finishRefusal(err)?.message ?? String(err);
  }
}

async function storedReason(runId: string): Promise<string | undefined> {
  return ((await stored(runId))?.refusal as { reason?: string } | undefined)?.reason;
}

async function untilState(runId: string, state: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if ((await stored(runId))?.state === state) return;
    await new Promise((d) => setTimeout(d, 50));
  }
  throw new Error(`the attempt never reached ${state}`);
}

/** Wait until a write to `pipeline_runs` in this database is blocked on a lock. */
async function untilAWriteWaits(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const waiting = await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query ILIKE 'update "pipeline_runs"%'
    `);
    if (Number(waiting[0]?.n ?? 0) > 0) return;
    await new Promise((d) => setTimeout(d, 20));
  }
  throw new Error('no write to pipeline_runs ever waited on the held row');
}

/** Abort the batch while its attempt is verifying, then let the probe go green or stay red. */
async function abortMidVerify(runId: string, goesGreen = true): Promise<void> {
  await accept(runId, PUSHED);
  const working = job.runReleaseBatchFinish(runId);
  await untilState(runId, 'verifying');
  await abort(runId);
  if (goesGreen) serving = PUSHED;
  await working;
}

describe('a batch aborted while its finish attempt is verifying', () => {
  it('ends the attempt failed as aborted, stamps no release and closes nothing', async () => {
    const { runId, issueIds } = await twoIssueBatch();

    await abortMidVerify(runId);

    expect(await stored(runId)).toMatchObject({
      state: 'failed',
      refusal: { code: 'RELEASE_BATCH_ABORTED' },
      closed: null,
      failed: null,
      owner: null,
    });
    expect(await shipped(runId)).toBeNull();
    expect(await fx.runStatus(runId)).toBe('cancelled');
    for (const id of issueIds) {
      expect((await fx.stored(id)).status).toBe('awaiting_release');
      expect(await closesOf(id)).toBe(0);
    }
  }, 30_000);

  it('ends the attempt as aborted, not unverified, when the probes never go green', async () => {
    const { runId } = await twoIssueBatch();

    await abortMidVerify(runId, false);

    expect(await stored(runId)).toMatchObject({
      state: 'failed',
      refusal: { code: 'RELEASE_BATCH_ABORTED' },
    });
    expect(await shipped(runId)).toBeNull();
  }, 40_000);

  it('answers a later finish on it with RELEASE_BATCH_ABORTED, with or without a commit', async () => {
    const { runId } = await twoIssueBatch();
    await abortMidVerify(runId);
    const before = await stored(runId);

    expect(await refusalCode(() => accept(runId, PUSHED))).toBe('RELEASE_BATCH_ABORTED');
    expect(await refusalCode(() => accept(runId))).toBe('RELEASE_BATCH_ABORTED');
    expect(await stored(runId)).toEqual(before);
  }, 30_000);

  it('stores the account a later finish is refused with: the claims were released', async () => {
    const { runId } = await twoIssueBatch();
    await abortMidVerify(runId);

    const reason = await storedReason(runId);
    expect(reason).toMatch(/its claims were released/);
    expect(await refusalMessage(() => accept(runId, PUSHED))).toBe(reason);
  }, 30_000);

  it('ends the attempt within one poll of the abort, not at the end of its verify window', async () => {
    await harness.db.execute(sql`
      UPDATE integration_bindings
      SET config = jsonb_set(config, '{verify,timeoutSeconds}', '120'::jsonb)
      WHERE project_id = ${projectId} AND provider = 'coolify'
    `);
    const { runId } = await twoIssueBatch();
    await accept(runId, PUSHED);
    const working = job.runReleaseBatchFinish(runId);
    await untilState(runId, 'verifying');

    await abort(runId);
    const abortedAt = Date.now();
    await working;

    expect(Date.now() - abortedAt).toBeLessThan(20_000);
    expect(await stored(runId)).toMatchObject({
      state: 'failed',
      refusal: { code: 'RELEASE_BATCH_ABORTED' },
    });
  }, 60_000);
});

describe('two aborts overlapping on one promoted batch', () => {
  it('keeps the later abort’s account when the earlier one settles after it', async () => {
    const { openAttempt } = await import('../../src/release-batch/ledger.js');
    const { runId, issueIds } = await twoIssueBatch();
    await openAttempt({ runId, stage: 'promote', idempotencyKey: 'promote-1', commit: PUSHED });

    // The first abort holds the roster and pauses before it settles; a second one returns the
    // roster to the gate in full inside that pause.
    await abort(runId, {
      afterRosterRecovered: async () => {
        await abort(runId, { promotedRoster: 'return-to-gate' });
      },
    });

    const said = await refusalMessage(() => accept(runId, PUSHED));
    expect(said).toMatch(/its claims were released/);
    expect(said).not.toMatch(/stay at `releasing`/);
    for (const id of issueIds) expect((await fx.stored(id)).status).toBe('awaiting_release');
  }, 30_000);
});

describe('a batch whose abort has begun and not yet cancelled its run', () => {
  it('claims no released roster while the abort stands stamped and unrecovered', async () => {
    const { stampAbort } = await import('../../src/release-batch/abort-stamp.js');
    const { runId, issueIds } = await twoIssueBatch();
    // What an abort that died after its first write leaves: the stamp, and nothing moved.
    await stampAbort(runId, { reason: 'stopped', by: ownerId, holdPromotedRoster: true });

    const said = await refusalMessage(() => accept(runId, PUSHED));
    expect(said).toMatch(/had not finished putting its roster back/);
    expect(said).not.toMatch(/claims were released/);
    for (const id of issueIds) expect((await fx.stored(id)).status).toBe('releasing');

    await abort(runId);
    expect(await refusalMessage(() => accept(runId, PUSHED))).toMatch(/its claims were released/);
  }, 30_000);

  it('stamps no release and ends the attempt aborted when verification goes green in that gap', async () => {
    const { runId, issueIds } = await twoIssueBatch();
    await accept(runId, PUSHED);
    const working = job.runReleaseBatchFinish(runId);
    await untilState(runId, 'verifying');

    // The roster is recovered and the run is still running: the worker goes green here and is
    // let finish before the abort cancels.
    await abort(runId, {
      afterRosterRecovered: async () => {
        expect(await fx.runStatus(runId)).toBe('running');
        serving = PUSHED;
        await working;
      },
    });

    expect(await shipped(runId)).toBeNull();
    expect(await stored(runId)).toMatchObject({
      state: 'failed',
      refusal: { code: 'RELEASE_BATCH_ABORTED' },
    });
    expect(await fx.runStatus(runId)).toBe('cancelled');
    for (const id of issueIds) expect(await closesOf(id)).toBe(0);
  }, 40_000);
  it.each([
    ['a roster the abort moves back', false, 'awaiting_release'],
    // Held by the abort, so still `releasing` and claimed: only the close fence stands between
    // the worker and closing it.
    ['a promoted roster the abort holds', true, 'releasing'],
  ])(
    'closes nothing of %s and stamps no release when the worker is already closing as the abort begins',
    async (_shape, promoted, rests) => {
      const { runId, issueIds } = await twoIssueBatch();
      if (promoted) {
        const { openAttempt } = await import('../../src/release-batch/ledger.js');
        await openAttempt({ runId, stage: 'promote', idempotencyKey: 'promote-1', commit: PUSHED });
      }
      serving = PUSHED;
      await accept(runId, PUSHED);
      let aborting: Promise<unknown> | null = null;
      let working: Promise<void> | null = null;

      working = job.runReleaseBatchFinish(runId, {
        // Green is committed; the abort runs up to its cancel, and the worker's closes go
        // through while the run still reads `running`.
        afterVerified: async () => {
          let inGap!: () => void;
          const gap = new Promise<void>((done) => {
            inGap = done;
          });
          aborting = abort(runId, {
            afterRosterRecovered: async () => {
              inGap();
              await working;
            },
          });
          await gap;
        },
      });
      await working;
      await aborting;

      expect(await shipped(runId)).toBeNull();
      expect(await stored(runId)).toMatchObject({
        state: 'failed',
        refusal: { code: 'RELEASE_BATCH_ABORTED' },
      });
      expect(await fx.runStatus(runId)).toBe('cancelled');
      for (const id of issueIds) {
        expect(await closesOf(id)).toBe(0);
        expect((await fx.stored(id)).status).toBe(rests);
      }
    },
    40_000,
  );
});

describe('a batch aborted after its verification went green', () => {
  it('closes no issue of a promoted roster the abort left claimed, and ends failed as aborted', async () => {
    const { openAttempt } = await import('../../src/release-batch/ledger.js');
    const { runId, issueIds } = await twoIssueBatch();
    await openAttempt({ runId, stage: 'promote', idempotencyKey: 'promote-1', commit: PUSHED });
    serving = PUSHED;
    await accept(runId, PUSHED);
    const notesAfterAbort: number[] = [];

    await job.runReleaseBatchFinish(runId, {
      afterVerified: async () => {
        await abort(runId);
        for (const id of issueIds) notesAfterAbort.push(await fx.commentCount(id));
      },
    });

    expect(await stored(runId)).toMatchObject({
      state: 'failed',
      refusal: { code: 'RELEASE_BATCH_ABORTED' },
      closed: [],
      failed: [],
    });
    expect(await shipped(runId)).toBeNull();
    const reason = await storedReason(runId);
    expect(reason).toMatch(/the abort kept its claims\. Its issues stay at `releasing`/);
    expect(reason).not.toMatch(/claims were released/);
    expect(await refusalMessage(() => accept(runId, PUSHED))).toBe(reason);
    for (const [i, id] of issueIds.entries()) {
      expect((await fx.stored(id)).status).toBe('releasing');
      expect(await closesOf(id)).toBe(0);
      // The abort's own note is the roster's last word: the worker adds no recovery note after it.
      expect(await fx.commentCount(id)).toBe(notesAfterAbort[i]);
    }

    // A second abort settles the roster: a later finish is told that, and the attempt keeps the
    // account that stood when it ended.
    await abort(runId, { promotedRoster: 'return-to-gate' });
    expect(await refusalMessage(() => accept(runId, PUSHED))).toMatch(/its claims were released/);
    expect(await storedReason(runId)).toBe(reason);
  }, 30_000);

  it('records no per-issue failure for a roster the abort moved back', async () => {
    const { runId, issueIds } = await twoIssueBatch();
    serving = PUSHED;
    await accept(runId, PUSHED);

    await job.runReleaseBatchFinish(runId, { afterVerified: () => abort(runId).then(() => {}) });

    expect(await stored(runId)).toMatchObject({
      state: 'failed',
      refusal: { code: 'RELEASE_BATCH_ABORTED' },
      closed: [],
      failed: [],
    });
    expect(await shipped(runId)).toBeNull();
    for (const id of issueIds) expect(await closesOf(id)).toBe(0);
  }, 30_000);
});

describe('a batch aborted just before its attempt writes its refusal', () => {
  it('ends the attempt as aborted rather than with the refusal it was about to write', async () => {
    const { runId } = await twoIssueBatch();
    serving = PUSHED;
    await accept(runId, PUSHED);
    let cancelling: Promise<void> | null = null;

    // The run row is held as the attempt fails, so its terminal write waits behind the lock;
    // the cancel then commits first, as an abort landing between the worker's last read and
    // its write does.
    await job.runReleaseBatchFinish(runId, {
      beforeFinishedWrite: async () => {
        let held!: () => void;
        const locked = new Promise<void>((done) => {
          held = done;
        });
        cancelling = harness.db.transaction(async (tx) => {
          await tx.execute(sql`SELECT id FROM pipeline_runs WHERE id = ${runId} FOR UPDATE`);
          held();
          await untilAWriteWaits();
          await tx.execute(sql`UPDATE pipeline_runs SET status = 'cancelled' WHERE id = ${runId}`);
        });
        await locked;
        throw new Error('planted: the terminal write failed');
      },
    });
    await (cancelling as unknown as Promise<void>);

    expect(await stored(runId)).toMatchObject({
      state: 'failed',
      refusal: { code: 'RELEASE_BATCH_ABORTED' },
    });
  }, 30_000);
});

describe('a batch aborted while the door is taking its finish', () => {
  it('refuses the finish and writes no record when the abort lands between the read and the write', async () => {
    const { runId } = await twoIssueBatch();
    serving = PUSHED;
    let answer: Promise<string | null> | null = null;

    // An abort landing between the door's read of the run and its write of the attempt.
    await harness.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM pipeline_runs WHERE id = ${runId} FOR UPDATE`);
      answer = refusalCode(() => accept(runId, PUSHED));
      await untilAWriteWaits();
      await tx.execute(sql`UPDATE pipeline_runs SET status = 'cancelled' WHERE id = ${runId}`);
    });

    expect(await (answer as unknown as Promise<string | null>)).toBe('RELEASE_BATCH_ABORTED');
    expect(await stored(runId)).toBeNull();
    // Cancelled by a write that was not an abort, so nothing records where the roster went.
    const said = await refusalMessage(() => accept(runId, PUSHED));
    expect(said).toMatch(/each issue’s own status and notes are the account/);
    expect(said).not.toMatch(/released|`releasing`|closed|gate/);
  }, 30_000);
});

describe('a batch that finished and was aborted afterwards', () => {
  it('keeps its finished record and answers a later finish as aborted', async () => {
    const { runId, issueIds } = await twoIssueBatch();
    serving = PUSHED;
    await accept(runId, PUSHED);
    await job.runReleaseBatchFinish(runId);
    const finished = await stored(runId);
    expect(finished).toMatchObject({ state: 'finished' });
    expect(await shipped(runId)).not.toBeNull();

    await abort(runId);

    expect(await refusalCode(() => accept(runId, PUSHED))).toBe('RELEASE_BATCH_ABORTED');
    const said = await refusalMessage(() => accept(runId, PUSHED));
    expect(said).toMatch(/already shipped, so the issues its finish closed stay closed/);
    expect(said).not.toMatch(/claims were released/);
    expect(await stored(runId)).toEqual(finished);
    for (const id of issueIds) expect(await closesOf(id)).toBe(1);
  }, 30_000);
});
