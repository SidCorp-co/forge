/**
 * ISS-1421 r4 — a hold whose reason clears by itself is sent again by `releaseHeldJobs` once that is
 * so, and only the dispatch tick ever called it; when that tick went, every such hold stayed held
 * for good, the anhome release among them. `releaseHeldJobsEverywhere` is its caller now, once a
 * minute across every project. A lineage that has spent its one automatic release stays held, and
 * a hold whose re-check is not due yet is left until it is.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase, truncateAll } from '../helpers/index.js';
import { type PoolBox, plantJob, seedPoolBox } from '../helpers/pool-lanes-fixture.js';

let harness: TestDatabase;
let box: PoolBox;
let m: {
  everywhere: typeof import('../../src/jobs/held-release.js').releaseHeldJobsEverywhere;
  holdJobForReason: typeof import('../../src/jobs/hold.js').holdJobForReason;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  const released = await import('../../src/jobs/held-release.js');
  const hold = await import('../../src/jobs/hold.js');
  m = { everywhere: released.releaseHeldJobsEverywhere, holdJobForReason: hold.holdJobForReason };
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  box = await seedPoolBox(harness);
});

/** A failed job, held for `reason` the way the failure path holds it. */
async function heldFor(reason: string, prompt: string): Promise<string> {
  const { jobId } = await plantJob(harness, box, { payload: { promptString: prompt } });
  return rehold(jobId, reason);
}

/** Fail `jobId` and hold its successor for `reason`, as the failure path does. */
async function rehold(jobId: string, reason: string): Promise<string> {
  await harness.db.execute(sql`
    UPDATE jobs SET status = 'failed', finished_at = now(), error = 'infra: connection reset'
    WHERE id = ${jobId}
  `);
  const { db } = await import('../../src/db/client.js');
  const { jobs } = await import('../../src/db/schema.js');
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!row) throw new Error('job vanished');
  const heldId = await m.holdJobForReason(row, reason);
  if (!heldId) throw new Error(`no hold for ${reason}`);
  return heldId;
}

async function statusOf(jobId: string): Promise<string> {
  const [row] = (await harness.db.execute(sql`
    SELECT status FROM jobs WHERE id = ${jobId}
  `)) as unknown as Array<{ status: string }>;
  return row?.status ?? 'gone';
}

const due = (jobId: string) =>
  harness.db.execute(sql`
    UPDATE jobs SET retry_after_at = now() - interval '1 minute' WHERE id = ${jobId}
  `);

describe('held jobs are sent again once their hold clears (criterion 56, 61)', () => {
  it('queues a self-clearing hold whose re-check is due, in one pass', async () => {
    const held = await heldFor('verify_unavailable', 'resume the held work');
    await due(held);

    expect(await m.everywhere()).toEqual({ released: 1, failed: 0 });
    expect(await statusOf(held)).toBe('queued');
  });

  it('leaves it held while its re-check is not due', async () => {
    const held = await heldFor('verify_unavailable', 'resume the held work');

    expect(await m.everywhere()).toEqual({ released: 0, failed: 0 });
    expect(await statusOf(held)).toBe('held');
  });

  it('leaves held a lineage that has spent its one automatic release', async () => {
    const first = await heldFor('verify_unavailable', 'resume the held work');
    await due(first);
    expect(await m.everywhere()).toEqual({ released: 1, failed: 0 });

    // The released job fails again and is held again, the way the failure path does it.
    const again = await rehold(first, 'verify_unavailable');
    await due(again);

    expect(await m.everywhere()).toEqual({ released: 0, failed: 0 });
    expect(await statusOf(again)).toBe('held');
  });

  it('leaves held a hold whose reason does not clear by itself', async () => {
    const held = await heldFor('retry_rounds_exhausted', 'resume the held work');

    expect(await m.everywhere()).toEqual({ released: 0, failed: 0 });
    expect(await statusOf(held)).toBe('held');
  });
});
