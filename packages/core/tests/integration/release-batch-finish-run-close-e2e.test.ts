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
  // ISS-1071 — what src/index.ts does at boot. This file builds the app from its own
  // modules rather than from that file, and a registry-backed path reads the registry
  // EMPTY, which throws rather than answering "no providers are declared".
  (await import('../../src/integrations/register-all.js')).registerAllIntegrations();
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
});

describe('a finish already run answers from the record', () => {
  // cm:guard the retry must not PROBE again, and that is a different claim from the close being
  // idempotent. The probes read the world now, not at the moment of the release: a site restarting,
  // a cache, or a later deploy all make a second read fail over a release that demonstrably landed,
  // and the caller would be handed RELEASE_NOT_VERIFIED about a batch that already closed its
  // roster. Every other case in this file configures no probes, so none of them reaches this path.
  it('raises nothing on a re-finish whose probes have stopped confirming', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    let serving = 'commit-before-the-release';
    const probe: Server = createServer((_req, res) => res.end(serving));
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    const { port } = probe.address() as AddressInfo;
    // cm:guard merged into the binding `beforeEach` already wrote, never a second
    // `declareProduction()`: a SERVICE binding is unique per (project, provider, label), and
    // a `||` keeps `releaseRunnerLabel` rather than clobbering the sibling key this project needs
    // to resolve its release pool at all.
    // cm:why `stableReads: 1` so one read confirms: the default is two, five seconds apart, and the
    // case is about the SECOND call's probing rather than about the poll loop's patience.
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

  // cm:guard a run at `completed` is NOT on its own proof this function ran: `reapConcludedRuns`
  // closes a `running` run `completed` once its last job is `done` and an hour has gone quiet, so a
  // batch whose release job ended before anyone called `finish` sits at exactly that status with
  // every issue still claimed. A re-finish shortcut keyed on the status alone answers that call
  // with a silent empty success and strands the whole roster at `releasing` with the claim column —
  // the only index onto those rows — never cleared. This case is the one that separates the two
  // guards; the status is written here directly because reaching it through the reaper would need
  // an hour of quiet and a dispatched job, and what is under test is `finish`'s reading of the
  // status rather than the reaper's writing of it.
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

describe('a finish racing an abort', () => {
  // cm:guard this is the case the pre-probe roster read made possible, and it asserts the abort
  // WINS. ISS-1032 hoisted the claim select above `verifyDeployed` so the retry guard could be read
  // before the probes, which means the roster is now snapshotted before a wait that can run tens of
  // seconds. A reviewer called that a stale-snapshot defect; the answer is `transitionIssueStatus`'s
  // UPDATE being conditional on the snapshot's own `fromStatus`, and this case is what proves it
  // rather than reading it. Asserting only the finish's return value would pass against a close
  // that had actually landed, so every field the abort owns is asserted here too.
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
    // cm:guard the hold is ARMED only after the cut, never from the first request: `createReleaseBatch`
    // probes too, to record `commitBefore`, and a server holding from the start wedges the claim
    // instead of the finish — the case would then time out having proved nothing about either.
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
      // cm:guard the gate status and no longer `reopen` (ISS-1042): this run recorded no
      // promotion, so the abort returned its roster to where it was waiting rather than saying it
      // had come back from a release.
    }).toEqual({ run: 'cancelled', issue: 'awaiting_release', claim: null });
  }, 60_000);
});

describe('a finish after an abort of a reaped run', () => {
  // cm:guard the reviewer's F2 case, asserted rather than argued. `reapConcludedRuns` can close a
  // run `completed` while its roster is still claimed; an operator then aborts, which reopens the
  // roster and clears the claims but CANNOT rewrite a run already terminal — `closeRunIfOneShot`
  // matches only `running|paused`. A later `finish` therefore meets `completed` with no claims and
  // answers from the record. The reviewer read that as finish being accepted as a previous success
  // and asked for provenance in `pipelineRuns.metadata`; what this case establishes is that the
  // empty answer is the truthful one — there is nothing left to close, the abort's `reopen` stands
  // and its cleared claim stays cleared. Probing here could only produce `RELEASE_NOT_VERIFIED`
  // about an empty roster, which is a worse account of a batch a person called off than saying
  // nothing closed. The roster-still-claimed half, which the guard must never swallow, is the case
  // above; both are needed and neither covers the other.
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
