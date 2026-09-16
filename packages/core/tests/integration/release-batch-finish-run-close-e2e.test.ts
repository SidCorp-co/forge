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
 *
 * Two `describe`s over one, and the setup hoisted to file scope between them:
 * the first group is what a FIRST finish leaves behind, the second is what a
 * SECOND finish on the same run answers, which is a different question about
 * the same function. One `describe` around both measured 157 lines against the
 * 150-line function budget `check-size-budget.mjs` freezes, and biome counts a
 * nested `describe` against its parent, so nesting them would not have paid.
 * The hooks stay single: one `setupTestDatabase` serves the whole file.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
});

describe('a finish already run answers from the record', () => {
  it('raises nothing on a re-finish whose probes have stopped confirming', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    let serving = 'commit-before-the-release';
    const probe: Server = createServer((_req, res) => res.end(serving));
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    const { port } = probe.address() as AddressInfo;
    await harness.db.execute(sql`
      UPDATE integration_bindings
      SET config = config || ${JSON.stringify({
        verify: {
          probes: [{ url: `http://127.0.0.1:${port}/version` }],
          timeoutSeconds: 20,
          stableReads: 1,
        },
      })}::jsonb
      WHERE project_id = ${projectId} AND provider = 'coolify' AND 'live' = ANY(stages)
    `);
    const a = await insertIssue();
    const { runId, jobId } = await claim([a]);
    serving = 'commit-the-release-pushed';

    const first = await finishReleaseBatch(runId, actor(), { commit: serving });
    expect(first.closed).toEqual([a]);
    await new Promise<void>((done) => probe.close(() => done()));

    const second = await finishReleaseBatch(runId, actor(), { commit: serving }).catch(
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
    let holding = false;
    const probe: Server = createServer((_req, res) => {
      if (!holding) {
        res.end('commit-before-the-release');
        return;
      }
      probeArrived();
      void held.then(() => res.end('commit-the-release-pushed'));
    });
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    const { port } = probe.address() as AddressInfo;
    await harness.db.execute(sql`
      UPDATE integration_bindings
      SET config = config || ${JSON.stringify({
        verify: {
          probes: [{ url: `http://127.0.0.1:${port}/version` }],
          timeoutSeconds: 20,
          stableReads: 1,
        },
      })}::jsonb
      WHERE project_id = ${projectId} AND provider = 'coolify' AND 'live' = ANY(stages)
    `);
    const a = await insertIssue();
    const { runId } = await claim([a]);

    holding = true;
    const finishing = finishReleaseBatch(runId, actor(), { commit: 'commit-the-release-pushed' });
    await arrived;
    await abortReleaseBatch(runId, 'the deploy never landed', ownerId);
    releaseProbe();
    const result = await finishing;
    await new Promise<void>((done) => probe.close(() => done()));

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
  //
  // ISS-1042 sharpened the answer rather than changing it. The abort now also takes the concluded
  // run to `cancelled` (`cancelConcludedRun`), so the later finish meets a run that SAYS it was
  // called off — and the refusal names that instead of returning the empty success, which ISS-1032's
  // own guard forbids on a `cancelled` run because it would make finish and abort report the same
  // thing. Everything the abort owns is still asserted below, unchanged.
  it('refuses, naming the abort, and leaves everything the abort did standing', async () => {
    const { abortReleaseBatch, finishReleaseBatch } = await import(
      '../../src/release-batch/service.js'
    );
    const probe: Server = createServer((_req, res) => res.end('a-commit-that-never-shipped'));
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    const { port } = probe.address() as AddressInfo;
    await harness.db.execute(sql`
      UPDATE integration_bindings
      SET config = config || ${JSON.stringify({
        verify: {
          probes: [{ url: `http://127.0.0.1:${port}/version` }],
          timeoutSeconds: 5,
          stableReads: 1,
        },
      })}::jsonb
      WHERE project_id = ${projectId} AND provider = 'coolify' AND 'live' = ANY(stages)
    `);
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET status = 'completed' WHERE id = ${runId}
    `);
    await abortReleaseBatch(runId, 'the deploy never landed', ownerId);

    const result = await finishReleaseBatch(runId, actor(), { commit: 'the-release-commit' }).catch(
      (e: unknown) => e,
    );
    await new Promise<void>((done) => probe.close(() => done()));

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('RELEASE_BATCH_ABORTED');
    expect({
      issue: (await stored(a)).status,
      claim: (await stored(a)).claim,
    }).toEqual({ issue: 'awaiting_release', claim: null });
  }, 60_000);
});
