/**
 * ISS-1032 — a finished batch has to release its run, not only its claims.
 *
 * `finishReleaseBatch` closed every claimed issue and never touched
 * `pipeline_runs.status`, so `getActiveReleaseBatch` — which selects any
 * `kind='system'` run carrying `metadata->>'source' = 'release-batch'` whose
 * status is `running` or `paused` — went on answering that finished run
 * forever and `createReleaseBatch` refused the next cut `BATCH_IN_FLIGHT`.
 * `reapConcludedRuns` could not clear it either: its candidate query excludes
 * a run with any job in `queued`, and the batch's own `release_batch` job was
 * still queued because `finish` never closed the run that would have reaped
 * it. The only exit was a human aborting a batch that had already shipped.
 *
 * Integration rather than unit because every assertion here is about what two
 * tables hold after the call — the run's status, the child job's status and
 * exit code, and whether the next `createReleaseBatch` is admitted — and a
 * mocked `closeRunIfOneShot` would assert the call this change makes rather
 * than the wedge it removes.
 *
 * Kept beside `release-batch-finish-e2e.test.ts` rather than inside it: that
 * file's cases are about the CLAIMS a finish releases, these are about the RUN
 * it closes, and its outer `describe` is already near the function-length
 * budget the fixture next door was extracted for.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

describe('release batch finish takes its run terminal', () => {
  let harness: TestDatabase;
  let projectId: string;
  let ownerId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  const fx = releaseBatchFixture(
    () => harness,
    () => ({ projectId, ownerId }),
  );
  const { declareProduction, seedReleaseRunner, insertIssue, stored } = fx;
  const { runStatus, storedJob, claim } = fx;

  const actor = () => ({ type: 'user', id: ownerId }) as const;

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
    await declareProduction();
    await seedReleaseRunner();
  });

  it('leaves the run at `completed` in the call that closes the claimed issues', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const a = await insertIssue();
    const { runId } = await claim([a]);
    expect(await runStatus(runId)).toBe('running');

    const result = await finishReleaseBatch(runId, actor());

    expect(result.closed).toEqual([a]);
    expect(await runStatus(runId)).toBe('completed');
    expect((await stored(a)).status).toBe('closed');
  });

  // cm:guard this is the wedge itself, and it is a different claim from the run's status: `getActiveReleaseBatch` is what `createReleaseBatch` consults, and a run left `running` is answered here whatever the issues did.
  it('stops `getActiveReleaseBatch` answering the batch once it has finished', async () => {
    const { finishReleaseBatch, getActiveReleaseBatch } = await import(
      '../../src/release-batch/service.js'
    );
    const a = await insertIssue();
    const { runId } = await claim([a]);
    expect((await getActiveReleaseBatch(projectId))?.runId).toBe(runId);

    await finishReleaseBatch(runId, actor());

    expect(await getActiveReleaseBatch(projectId)).toBeNull();
  });

  // cm:why no sweeper tick is run anywhere in this case, deliberately: the filing's stronger claim is that the next cut needs no reaper pass, and a test that ticked the sweeper first would pass against a `finish` that still left the run open.
  it('admits the next cut in the call straight after a finish', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await finishReleaseBatch(runId, actor());

    const b = await insertIssue();
    const next = await claim([b]);

    expect(next.runId).not.toBe(runId);
    expect(await runStatus(next.runId)).toBe('running');
  });

  it('raises no `BatchInFlightError` on the cut that follows a finish', async () => {
    const { BatchInFlightError, finishReleaseBatch } = await import(
      '../../src/release-batch/service.js'
    );
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await finishReleaseBatch(runId, actor());

    const b = await insertIssue();
    const outcome = await claim([b]).catch((e: unknown) => e);

    expect(outcome).not.toBeInstanceOf(BatchInFlightError);
  });

  // cm:guard `done`, never `cancelled`, and that is the whole reason the close is `completed`: `reasonForOutcome('completed')` is the cascade's success sentinel, and the `release_batch` job it reaps is the job whose own session CALLED finish. A cancelling close would broadcast a kill at the session that just shipped the release — ISS-352's false-failed badge.
  it('flips the still-queued `release_batch` job to `done`', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const a = await insertIssue();
    const { runId, jobId } = await claim([a]);
    expect((await storedJob(jobId)).status).toBe('queued');

    await finishReleaseBatch(runId, actor());

    expect((await storedJob(jobId)).status).toBe('done');
  });

  it('gives that reaped `release_batch` job exit code 0', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const a = await insertIssue();
    const { runId, jobId } = await claim([a]);
    expect((await storedJob(jobId)).exitCode).toBeNull();

    await finishReleaseBatch(runId, actor());

    expect((await storedJob(jobId)).exitCode).toBe(0);
  });

  // cm:guard a finish and an abort must not report the same outcome: both take the run terminal, and the status is the only field that says which one happened. Asserting `completed` alone would pass equally if `finish` had been given abort's `cancelled`.
  it('reports a finish differently from an abort', async () => {
    const { abortReleaseBatch, finishReleaseBatch } = await import(
      '../../src/release-batch/service.js'
    );
    const a = await insertIssue();
    const finished = await claim([a]);
    await finishReleaseBatch(finished.runId, actor());

    const b = await insertIssue();
    const aborted = await claim([b]);
    await abortReleaseBatch(aborted.runId, 'the deploy never landed', ownerId);

    expect(await runStatus(finished.runId)).toBe('completed');
    expect(await runStatus(aborted.runId)).toBe('cancelled');
  });

  // cm:guard the run closes on a PARTIAL finish too. A run held open because one issue would not close is the same wedge with a better excuse: the project cannot cut its next batch, and `recoverStrandedReleasing` has already landed that issue at `reopen` with the reason, which is where a partial finish is accounted for.
  // cm:why `statusEntryCriteria.closed: ['plan']` is the cheapest real refusal of a close — the project declares it, `checkTransitionEvidence` enforces it against a human actor too, and the fixture's issues carry no plan. Forcing the failure with a stub would prove the stub.
  it('leaves the run terminal when an issue could not be closed', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await harness.db.execute(sql`
      UPDATE projects
      SET agent_config = ${JSON.stringify({
        pipelineConfig: { statusEntryCriteria: { closed: ['plan'] } },
      })}::jsonb
      WHERE id = ${projectId}
    `);

    const result = await finishReleaseBatch(runId, actor());

    expect(result.closed).toEqual([]);
    expect(result.failed.map((f) => f.id)).toEqual([a]);
    expect(await runStatus(runId)).toBe('completed');
  });

  it('raises nothing when `finish` is called a second time', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await finishReleaseBatch(runId, actor());

    const second = await finishReleaseBatch(runId, actor()).catch((e: unknown) => e);

    expect(second).toEqual({ closed: [], failed: [] });
  });

  // cm:guard the second call must move NOTHING, and the run is the field that could move: `closeRunIfOneShot` matches only `running|paused`, so a re-finish that re-opened or re-closed the run would show here as a status other than the one the first call left.
  it('leaves the run, the issue and the job where the first `finish` left them', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const a = await insertIssue();
    const { runId, jobId } = await claim([a]);
    await finishReleaseBatch(runId, actor());
    const before = {
      run: await runStatus(runId),
      issue: (await stored(a)).status,
      job: await storedJob(jobId),
    };
    expect(before).toEqual({
      run: 'completed',
      issue: 'closed',
      job: { status: 'done', exitCode: 0 },
    });

    await finishReleaseBatch(runId, actor());

    expect({
      run: await runStatus(runId),
      issue: (await stored(a)).status,
      job: await storedJob(jobId),
    }).toEqual(before);
  });
});
