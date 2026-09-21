/**
 * ISS-1080 criterion 12 — the notification cannot be stranded by a crash.
 *
 * `recoverUnstartedReleaseBatches` runs four writes in a row, and only one of
 * them is a point of no return: closing the run is what stops the pass's own
 * resume arm matching, because that arm requires `pr.status = 'running'`. So a
 * worker dying between the close and the wedge would leave an owner permanently
 * uninformed about a roster that moved under them, with no later tick able to
 * reach the row. Everything before the close is re-entrant.
 *
 * Its own file, because the proof is a wedge write that refuses ONCE and
 * `vi.mock` is hoisted per file — resetting modules mid-file took the shared
 * harness with it. The sibling suite keeps a source-order assertion of the same
 * property; this is the behavioural half, and it is the one that would also
 * catch an ordering that is right in the source and wrong at run time.
 */

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

const REFUSAL = 'the notification write failed';
const state = vi.hoisted(() => ({ refuseOnce: true }));

vi.mock('../../src/pipeline/wedge.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/pipeline/wedge.js')>();
  return {
    ...real,
    emitPipelineWedge: async (ev: Parameters<typeof real.emitPipelineWedge>[0]) => {
      if (state.refuseOnce) {
        state.refuseOnce = false;
        throw new Error(REFUSAL);
      }
      return real.emitPipelineWedge(ev);
    },
  };
});

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let recoverUnstartedReleaseBatches: typeof import('../../src/release-batch/unstarted-recovery.js').recoverUnstartedReleaseBatches;
let deadlineMinutes: number;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
  const m = await import('../../src/release-batch/unstarted-recovery.js');
  recoverUnstartedReleaseBatches = m.recoverUnstartedReleaseBatches;
  deadlineMinutes = m.RELEASE_UNSTARTED_DEADLINE_MS / 60_000;
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);
const { declareProduction, seedReleaseRunner, insertIssue, stored, claim, runStatus } = fx;

beforeEach(async () => {
  await declareProduction();
  await seedReleaseRunner();
});

async function ageJob(jobId: string, minutes: number): Promise<void> {
  await harness.db.execute(sql`
    UPDATE jobs SET queued_at = now() - (${minutes}::int * interval '1 minute') WHERE id = ${jobId}
  `);
}

async function wedgesFor(jobId: string): Promise<number> {
  const rows = (await harness.db.execute(sql`
    SELECT count(*)::int AS n FROM notifications
    WHERE type = 'pipeline_wedge' AND resolution_key = ${`wedge:${jobId}`}
  `)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

describe('a recovery whose notification will not write', () => {
  it('leaves the run open, so the next tick finishes both halves', async () => {
    const a = await insertIssue();
    const { runId, jobId } = await claim([a]);
    await ageJob(jobId, deadlineMinutes + 5);

    await expect(recoverUnstartedReleaseBatches(new Date())).rejects.toThrow(REFUSAL);

    expect(await runStatus(runId)).toBe('running');
    expect(await wedgesFor(jobId)).toBe(0);
    expect(await stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });

    expect(await recoverUnstartedReleaseBatches(new Date())).toEqual({ recovered: 1 });

    expect(await wedgesFor(jobId)).toBe(1);
    expect(await runStatus(runId)).toBe('cancelled');
    expect(await stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
  });
});
