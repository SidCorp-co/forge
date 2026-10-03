import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { collapseProbeWaits } from '../helpers/probe-window.js';
import { PROBE_URL, releaseBatchFixture } from '../helpers/release-batch-fixture.js';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
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

const actor = () => ({ type: 'user', id: ownerId, agency: 'human' as const }) as const;

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  await declareProduction();
  await seedReleaseRunner();
});

describe('release batch finish takes its run terminal', () => {
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

  it('leaves the run terminal when an issue could not be closed', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const a = await insertIssue();
    const { runId } = await claim([a]);
    // The close refuses an issue carrying no ship claim (CLOSE_REQUIRES_SHIPPED); taking the claim
    // off after the batch is cut is the one refusal a finish cannot talk its way past.
    await harness.db.execute(sql`UPDATE issues SET merged_at = NULL WHERE id = ${a}`);

    const result = await finishReleaseBatch(runId, actor());

    expect(result.closed).toEqual([]);
    expect(result.failed.map((f) => f.id)).toEqual([a]);
    expect(await runStatus(runId)).toBe('completed');
  });
});

/** Whole object names: a claim `finish` verifies may be nothing else (ISS-1161). */
const BEFORE = '1111111111111111111111111111111111111111';
const PUSHED = '2222222222222222222222222222222222222222';
const NEVER_SHIPPED = '3333333333333333333333333333333333333333';

describe('a finish already run answers from the record', () => {
  it('raises nothing on a re-finish whose probes have stopped confirming', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    fx.serve(BEFORE);
    const a = await insertIssue();
    const { runId, jobId } = await claim([a], { deploy: false });
    fx.serve(PUSHED);

    const first = await finishReleaseBatch(runId, actor(), { commit: PUSHED });
    expect(first.closed).toEqual([a]);
    const gone = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    onTestFinished(() => gone.mockRestore());

    const second = await finishReleaseBatch(runId, actor(), { commit: PUSHED }).catch(
      (e: unknown) => e,
    );

    expect(second).toEqual({ closed: [], failed: [] });
    expect({
      run: await runStatus(runId),
      issue: (await stored(a)).status,
      job: await storedJob(jobId),
    }).toEqual({ run: 'completed', issue: 'closed', job: { status: 'done', exitCode: 0 } });
  }, 60_000);

  it('raises nothing when `finish` is called a second time', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await finishReleaseBatch(runId, actor());

    const second = await finishReleaseBatch(runId, actor()).catch((e: unknown) => e);

    expect(second).toEqual({ closed: [], failed: [] });
  });

  it('still closes a roster whose run went `completed` without a finish', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET status = 'completed' WHERE id = ${runId}
    `);

    const result = await finishReleaseBatch(runId, actor());

    expect(result).toEqual({ closed: [a], failed: [] });
    expect((await stored(a)).status).toBe('closed');
    expect((await stored(a)).claim).toBeNull();
  });

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

describe('a finish racing an abort', () => {
  it('lets a concurrent abort keep the issues it reopened', async () => {
    const { abortReleaseBatch, finishReleaseBatch } = await import(
      '../../src/release-batch/service.js'
    );
    let releaseProbe: () => void = () => {};
    let probeArrived: () => void = () => {};
    const arrived = new Promise<void>((done) => {
      probeArrived = done;
    });
    const held = new Promise<void>((done) => {
      releaseProbe = done;
    });
    fx.serve(BEFORE);
    const a = await insertIssue();
    const { runId } = await claim([a], { deploy: false });

    const passThrough = globalThis.fetch;
    const holding = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.split('?')[0] !== PROBE_URL) return passThrough(input, init);
      probeArrived();
      await held;
      return Response.json({ commit: PUSHED });
    });
    onTestFinished(() => holding.mockRestore());
    const finishing = finishReleaseBatch(runId, actor(), { commit: PUSHED });
    await arrived;
    await abortReleaseBatch(runId, 'the deploy never landed', ownerId);
    releaseProbe();
    const result = await finishing;

    expect(result.closed).toEqual([]);
    expect(result.failed.map((f) => f.id)).toEqual([a]);
    expect({
      run: await runStatus(runId),
      issue: (await stored(a)).status,
      claim: (await stored(a)).claim,
    }).toEqual({ run: 'cancelled', issue: 'awaiting_release', claim: null });
  }, 60_000);
});

describe('a finish after an abort of a reaped run', () => {
  it('refuses, naming the abort, and leaves everything the abort did standing', async () => {
    const { abortReleaseBatch, finishReleaseBatch } = await import(
      '../../src/release-batch/service.js'
    );
    const a = await insertIssue();
    const { runId } = await claim([a]);
    fx.serve(NEVER_SHIPPED);
    onTestFinished(collapseProbeWaits());
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET status = 'completed' WHERE id = ${runId}
    `);
    await abortReleaseBatch(runId, 'the deploy never landed', ownerId);

    const result = await finishReleaseBatch(runId, actor(), { commit: PUSHED }).catch(
      (e: unknown) => e,
    );

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('RELEASE_BATCH_ABORTED');
    expect({
      issue: (await stored(a)).status,
      claim: (await stored(a)).claim,
    }).toEqual({ issue: 'awaiting_release', claim: null });
  }, 60_000);
});
