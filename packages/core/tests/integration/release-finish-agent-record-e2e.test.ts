/**
 * A release batch's finish is its agent's record of the release under the version it was cut with
 * (ISS-851, owner ruling 2026-11-01, `release-is-the-agents-record`). Forge reads no source probe and
 * no deployment record to close the roster, replays no kept probe, and keeps a commit the finish
 * names as evidence, never checked. Every live reader is planted to throw and count, so a read is
 * the defect under test. Against real Postgres.
 *
 * @direct-test-of packages/core/src/release-batch/finish.ts
 * @direct-test-of packages/core/src/release-batch/finish-job.ts
 * @direct-test-of packages/core/src/release-batch/create.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransitionActor } from '../../src/issues/index.js';
import { finishReleaseBatch } from '../../src/release-batch/finish.js';
import { acceptReleaseBatchFinish } from '../../src/release-batch/finish-job.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { releaseWorld } from '../helpers/release-world.js';

const reads = vi.hoisted(() => ({ n: 0 }));

vi.mock('../../src/release-batch/verify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/verify.js')>()),
  readLiveState: async () => {
    reads.n += 1;
    throw new Error('a release finish read production (readLiveState)');
  },
}));
vi.mock('../../src/release-batch/serving-reading.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/serving-reading.js')>()),
  readServingNow: async () => {
    reads.n += 1;
    throw new Error('a release finish read the deployment record (readServingNow)');
  },
}));

let projectId: string;
let ownerId: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  reads.n = 0;
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  await fx.seedReleaseRunner();
});

const actor = (): TransitionActor => ({ type: 'user', id: ownerId, agency: 'agent' });

async function runOf(runId: string) {
  const [run] = await rows<{ status: string; metadata: Record<string, unknown> }>(sql`
    SELECT status, metadata FROM pipeline_runs WHERE id = ${runId}
  `);
  return run;
}

describe("a batch's finish closes on its agent's record (ISS-851)", () => {
  it('closes the roster where production declares a source probe, reading none', async () => {
    await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] }, 'source');
    const a = await fx.insertIssue('awaiting_release');
    const b = await fx.insertIssue('awaiting_release');
    const { runId, verification } = await fx.claim([a, b]);
    expect(verification).toBe('recorded');

    const result = await finishReleaseBatch(runId, actor());

    expect(new Set(result.closed)).toEqual(new Set([a, b]));
    expect(result.failed).toEqual([]);
    expect(reads.n).toBe(0);
    const run = await runOf(runId);
    expect(run?.status).toBe('completed');
    expect(run?.metadata.verification).toBe('recorded');
    expect(run?.metadata).not.toHaveProperty('probeReplay');
    expect(run?.metadata).not.toHaveProperty('commitBefore');
  });

  it('closes the roster where production declares no probe, reading no deployment record', async () => {
    await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] }, 'none');
    const issue = await fx.insertIssue('awaiting_release');
    const { runId } = await fx.claim([issue]);

    const result = await finishReleaseBatch(runId, actor());

    expect(result).toEqual({ closed: [issue], failed: [] });
    expect(reads.n).toBe(0);
    expect((await runOf(runId))?.metadata.verification).toBe('recorded');
    expect(await fx.stored(issue)).toMatchObject({ status: 'closed', claim: null });
  });

  it('takes a short commit at the door as evidence, never refusing its shape', async () => {
    await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] }, 'source');
    const issue = await fx.insertIssue('awaiting_release');
    const { runId } = await fx.claim([issue]);

    const accepted = await acceptReleaseBatchFinish(
      runId,
      actor(),
      { commit: 'ABC1234' },
      async () => {},
    );

    expect(accepted.started).toBe(true);
    expect(accepted.finish).toMatchObject({ state: 'accepted', commit: 'abc1234' });
    expect(reads.n).toBe(0);
  });

  it('takes a finish naming no commit on a batch that recorded nothing serving', async () => {
    await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] }, 'source');
    const issue = await fx.insertIssue('awaiting_release');
    const { runId } = await fx.claim([issue]);

    const accepted = await acceptReleaseBatchFinish(runId, actor(), {}, async () => {});

    expect(accepted.finish).toMatchObject({ state: 'accepted', commit: null });
    expect(reads.n).toBe(0);
  });
});
