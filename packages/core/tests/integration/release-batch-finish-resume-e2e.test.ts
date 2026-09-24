/**
 * ISS-1190 — a finish attempt whose worker died is taken up again, and one whose
 * worker is alive is left alone, against real Postgres.
 *
 * Each case plants the record a worker would have left behind at the moment it
 * died, then runs the sweep with a wake-up that does the work inline, so what is
 * measured is the sweep's choice and the worker's resumption rather than the
 * queue's polling interval (the queue path is the async suite's).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

const closeRun = vi.hoisted(() => ({ failNext: false }));
vi.mock('../../src/pipeline/runs.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/pipeline/runs.js')>();
  return {
    ...real,
    closeRunIfOneShot: async (...args: Parameters<typeof real.closeRunIfOneShot>) => {
      if (closeRun.failNext) {
        closeRun.failNext = false;
        throw new Error('planted: the run close failed');
      }
      return real.closeRunIfOneShot(...args);
    },
  };
});

const BEFORE = '1111111111111111111111111111111111111111';
const PUSHED = '2222222222222222222222222222222222222222';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let serving = BEFORE;
let probe: Server;
let probeUrl: string;
let job: typeof import('../../src/release-batch/finish-job.js');

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
      verify: { probes: [{ url: probeUrl }], timeoutSeconds: 6, stableReads: 1 },
    })}::jsonb
    WHERE project_id = ${projectId} AND provider = 'coolify'
  `);
});

async function batch() {
  const issueId = await fx.insertIssue();
  const { runId } = await fx.claim([issueId]);
  return { runId, issueId };
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function plant(
  runId: string,
  over: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const record = {
    requestId: 'r-planted',
    state: 'accepted',
    commit: PUSHED,
    requestedBy: { type: 'user', id: ownerId },
    acceptedAt: iso(-600_000),
    updatedAt: iso(-600_000),
    version: 3,
    owner: null,
    leaseUntil: null,
    workerStarts: 1,
    closed: null,
    failed: null,
    refusal: null,
    finishedAt: null,
    ...over,
  };
  await harness.db.execute(sql`
    UPDATE pipeline_runs SET metadata = metadata || ${JSON.stringify({ finish: record })}::jsonb
    WHERE id = ${runId}
  `);
  return record;
}

async function stored(runId: string): Promise<Record<string, unknown> | null> {
  const rows = await harness.db.execute(sql`
    SELECT metadata -> 'finish' AS finish FROM pipeline_runs WHERE id = ${runId}
  `);
  return (rows[0]?.finish as Record<string, unknown> | null) ?? null;
}

async function closesOf(issueId: string): Promise<number> {
  const rows = await harness.db.execute(sql`
    SELECT count(*)::int AS n FROM kernel_transitions
    WHERE entity = 'issue' AND entity_id = ${issueId} AND to_status = 'closed'
  `);
  return Number(rows[0]?.n ?? 0);
}

/** The sweep, with a wake-up that runs the worker to its end before answering. */
async function sweep(): Promise<string[]> {
  const { woken } = await job.resumeStrandedFinishes(new Date(), async (runId) => {
    await job.runReleaseBatchFinish(runId);
  });
  return woken;
}

describe('the sweep takes up an attempt nobody is working', () => {
  it('resumes an attempt whose owner stopped renewing, and it reaches finished', async () => {
    const { runId, issueId } = await batch();
    serving = PUSHED;
    await plant(runId, { state: 'verifying', owner: 'dead-worker', leaseUntil: iso(-1_000) });

    expect(await sweep()).toEqual([runId]);

    expect(await stored(runId)).toMatchObject({
      state: 'finished',
      closed: [issueId],
      workerStarts: 2,
    });
    expect((await fx.stored(issueId)).status).toBe('closed');
    expect(await fx.runStatus(runId)).toBe('completed');
  }, 30_000);

  it('resumes an attempt that died after verification went green without probing again', async () => {
    const { runId, issueId } = await batch();
    await plant(runId, { state: 'closing', owner: 'dead-worker', leaseUntil: iso(-1_000) });

    expect(await sweep()).toEqual([runId]);

    expect(await stored(runId)).toMatchObject({ state: 'finished', closed: [issueId] });
    expect((await fx.stored(issueId)).status).toBe('closed');
  }, 30_000);

  it('completes the run of a finished attempt whose worker died before the run closed', async () => {
    const { runId, issueId } = await batch();
    const planted = await plant(runId, { state: 'finished', closed: [issueId], failed: [] });

    expect(await sweep()).toEqual([runId]);

    expect(await fx.runStatus(runId)).toBe('completed');
    expect(await stored(runId)).toEqual(planted);
    expect((await fx.stored(issueId)).status).toBe('releasing');
    expect(await closesOf(issueId)).toBe(0);
  }, 30_000);
});

describe('a live worker keeps its attempt', () => {
  it('is not woken by the sweep, and a second worker changes nothing', async () => {
    const { runId } = await batch();
    serving = PUSHED;
    const planted = await plant(runId, {
      state: 'verifying',
      owner: 'live-worker',
      leaseUntil: iso(60_000),
    });

    expect(await sweep()).toEqual([]);
    await job.runReleaseBatchFinish(runId);

    expect(await stored(runId)).toEqual(planted);
    expect(await fx.runStatus(runId)).toBe('running');
  }, 30_000);

  it('stops a worker whose lease was taken over before it closes anything', async () => {
    const { runId, issueId } = await batch();
    await plant(runId, { state: 'accepted', updatedAt: iso(0) });

    const working = job.runReleaseBatchFinish(runId);
    const taken = await (async () => {
      for (let i = 0; i < 40; i += 1) {
        const r = await stored(runId);
        if (r?.state === 'verifying' && typeof r.owner === 'string') return r;
        await new Promise((d) => setTimeout(d, 50));
      }
      throw new Error('the worker never took the attempt');
    })();
    const thief = await plant(runId, {
      ...taken,
      owner: 'thief',
      leaseUntil: iso(60_000),
      version: (taken.version as number) + 10,
    });
    serving = PUSHED;
    await working;

    expect(await stored(runId)).toEqual(thief);
    expect((await fx.stored(issueId)).status).toBe('releasing');
    expect(await closesOf(issueId)).toBe(0);
    expect(await fx.runStatus(runId)).toBe('running');
  }, 30_000);
});

describe('a worker that loses its hold mid-close, and a run close that fails', () => {
  async function shipped(runId: string): Promise<unknown> {
    const rows = await harness.db.execute(sql`
      SELECT release_released_at FROM pipeline_runs WHERE id = ${runId}
    `);
    return rows[0]?.release_released_at ?? null;
  }

  it('closes nothing more once its lease is taken over after the green verdict', async () => {
    const { runId, issueId } = await batch();
    await plant(runId, { state: 'closing', owner: 'dead-worker', leaseUntil: iso(-1_000) });
    let thief: Record<string, unknown> | null = null;

    await job.runReleaseBatchFinish(runId, {
      afterVerified: async () => {
        const taken = (await stored(runId)) as Record<string, unknown>;
        thief = await plant(runId, {
          ...taken,
          owner: 'thief',
          leaseUntil: iso(60_000),
          version: (taken.version as number) + 10,
        });
      },
    });

    expect(await stored(runId)).toEqual(thief);
    expect((await fx.stored(issueId)).status).toBe('releasing');
    expect(await closesOf(issueId)).toBe(0);
    expect(await shipped(runId)).toBeNull();
    expect(await fx.runStatus(runId)).toBe('running');
  }, 30_000);

  it('keeps a finished record finished when only the run close failed, and the sweep closes the run', async () => {
    const { runId, issueId } = await batch();
    serving = PUSHED;
    await plant(runId, { state: 'verifying', owner: 'dead-worker', leaseUntil: iso(-1_000) });
    closeRun.failNext = true;

    await job.runReleaseBatchFinish(runId);

    expect(await stored(runId)).toMatchObject({
      state: 'finished',
      closed: [issueId],
      refusal: null,
    });
    expect(await fx.runStatus(runId)).toBe('running');

    expect(await sweep()).toEqual([runId]);
    expect(await fx.runStatus(runId)).toBe('completed');
    expect(await closesOf(issueId)).toBe(1);
  }, 30_000);
});
