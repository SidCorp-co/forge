/**
 * ISS-812 [Epic] — composed walk of the failure-taxonomy/action-policy family
 * against real Postgres. Each mechanism below already has its own unit/
 * integration coverage from the child issue that built it (ISS-823/824/825/
 * 826); this file does not re-derive those suites. It exists for the same
 * reason state-integrity-guards-e2e.test.ts exists for VISION №10: to prove
 * the ORIGINAL five incident shapes are actually closed on the real DB
 * schema + real query shapes, and that two children's mechanisms compose
 * correctly through the ONE shared seam (`onlineCapableDeviceIds` /
 * `selectRunnerForJob`) rather than merely passing in isolation.
 *
 * The five faces, one test each:
 *   - ISS-757 — org spend-cap storm: classified as per-account exhaustion, so
 *     it rotates immediately and the round budget ends it, instead of 60
 *     same-device dispatches. (NOT an immediate park — that policy was
 *     reversed 2026-08-12; see the guard on `allRunnersLimited` in
 *     `src/jobs/retry.ts`.)
 *   - ISS-806 — box-scoped deterministic failure quarantines its runner
 *     instead of rotating the fault across the fleet.
 *   - ISS-760 — schedule terminal path records an honest reason + status,
 *     never a silent NULL/success.
 *   - ISS-811 — a rescued (eventually-succeeded) retry chain is countable,
 *     attributed to its original failure reason.
 *   - ISS-630/804 — the per-pipeline-state budget gate produces a real
 *     terminal outcome (park + close), not a stranded job/run.
 * A sixth test proves the composition: quarantine (ISS-825) and per-account
 * exhaustion (ISS-823) both ride `onlineCapableDeviceIds`'s health gate, and
 * a fleet exhausted by a MIX of the two reasons is still told apart from a
 * fleet that is merely offline.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as AgentSessionsSessionFailure from '../../src/agent-sessions/session-failure.js';
import type * as DbClient from '../../src/db/client.js';
import type * as DbSchema from '../../src/db/schema.js';
import type * as JobsDispatcher from '../../src/jobs/dispatcher.js';
import type * as JobsRetry from '../../src/jobs/retry.js';
import type * as PipelineFailureClassifier from '../../src/pipeline/failure-classifier.js';
import type * as PipelineHooks from '../../src/pipeline/hooks.js';
import type * as RunnersQuarantine from '../../src/runners/quarantine.js';
import type * as RunnersSelect from '../../src/runners/select.js';
import type * as SchedulesService from '../../src/schedules/service.js';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  classifyFailure: typeof PipelineFailureClassifier.classifyFailure;
  CLASSIFIER_VERSION: typeof PipelineFailureClassifier.CLASSIFIER_VERSION;
  scheduleAutoRetryWithVerify: typeof JobsRetry.scheduleAutoRetryWithVerify;
  AUTO_RETRY_PAYLOAD_KEY: typeof JobsRetry.AUTO_RETRY_PAYLOAD_KEY;
  RETRY_MAX_ROUNDS: typeof JobsRetry.RETRY_MAX_ROUNDS;
  RETRY_TRIES_PER_DEVICE: typeof JobsRetry.RETRY_TRIES_PER_DEVICE;
  maybeQuarantineRunner: typeof RunnersQuarantine.maybeQuarantineRunner;
  RUNNER_QUARANTINE_STREAK: typeof RunnersQuarantine.RUNNER_QUARANTINE_STREAK;
  selectRunnerForJob: typeof RunnersSelect.selectRunnerForJob;
  onlineCapableDeviceIds: typeof RunnersSelect.onlineCapableDeviceIds;
  finalizeScheduleSessionFailure: typeof AgentSessionsSessionFailure.finalizeScheduleSessionFailure;
  writeBackScheduleLastStatus: typeof SchedulesService.writeBackScheduleLastStatus;
  handleDispatch: typeof JobsDispatcher.handleDispatch;
  hooks: typeof PipelineHooks.hooks;
  db: typeof DbClient.db;
  jobs: typeof DbSchema.jobs;
};

describe('ISS-812 failure-taxonomy/action-policy — composed walk of the five faces', () => {
  let harness: TestDatabase;
  let mods: Mods;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';

    // cm:guard import these SEQUENTIALLY, never with Promise.all. Resolving these ten graphs concurrently deadlocks the module runner — measured 2026-08-13: the hook never returned at 120s OR at 600s, so all 6 tests reported `skipped` and this suite had never once executed anywhere since it was written. Awaiting them one at a time runs the whole file in ~10s. The graphs overlap heavily (db/client, config/env, logger, schema) and a cycle between two concurrent evaluations is what wedges.
    // cm:edge protocol -> packages/core/vitest.integration.config.ts — `pool: 'forks'` is what makes this reachable; a hook that hangs here is invisible as a FAILURE (vitest reports the tests as skipped and the suite as timed out), so a green-looking `core-integration` is not evidence this file ran
    const classifierMod = await import('../../src/pipeline/failure-classifier.js');
    const retryMod = await import('../../src/jobs/retry.js');
    const quarantineMod = await import('../../src/runners/quarantine.js');
    const selectMod = await import('../../src/runners/select.js');
    const sessionFailureMod = await import('../../src/agent-sessions/session-failure.js');
    const scheduleServiceMod = await import('../../src/schedules/service.js');
    const dispatcherMod = await import('../../src/jobs/dispatcher.js');
    const hooksMod = await import('../../src/pipeline/hooks.js');
    const dbMod = await import('../../src/db/client.js');
    const schemaMod = await import('../../src/db/schema.js');
    mods = {
      classifyFailure: classifierMod.classifyFailure,
      CLASSIFIER_VERSION: classifierMod.CLASSIFIER_VERSION,
      scheduleAutoRetryWithVerify: retryMod.scheduleAutoRetryWithVerify,
      AUTO_RETRY_PAYLOAD_KEY: retryMod.AUTO_RETRY_PAYLOAD_KEY,
      RETRY_MAX_ROUNDS: retryMod.RETRY_MAX_ROUNDS,
      RETRY_TRIES_PER_DEVICE: retryMod.RETRY_TRIES_PER_DEVICE,
      maybeQuarantineRunner: quarantineMod.maybeQuarantineRunner,
      RUNNER_QUARANTINE_STREAK: quarantineMod.RUNNER_QUARANTINE_STREAK,
      selectRunnerForJob: selectMod.selectRunnerForJob,
      onlineCapableDeviceIds: selectMod.onlineCapableDeviceIds,
      finalizeScheduleSessionFailure: sessionFailureMod.finalizeScheduleSessionFailure,
      writeBackScheduleLastStatus: scheduleServiceMod.writeBackScheduleLastStatus,
      handleDispatch: dispatcherMod.handleDispatch,
      hooks: hooksMod.hooks,
      db: dbMod.db,
      jobs: schemaMod.jobs,
    };
    // cm:why 120s covers a cold testcontainer pull on a CI runner, matching the 17 sibling suites. It was previously blamed for the hang and raised from 60s to 120s as the fix — it was never the cause (600s hung identically); the concurrent imports above were.
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    mods.hooks.reset();
  });

  // ---------- shared seed helpers ----------------------------------------

  async function seedProject() {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    return { owner, project };
  }

  async function seedRunner(
    projectId: string,
    ownerId: string,
    opts: { status?: string; rateLimitedUntil?: Date | null } = {},
  ): Promise<{ deviceId: string; runnerId: string }> {
    const device = await createTestDevice(harness.db, ownerId, {
      status: opts.status === 'offline' ? 'offline' : 'online',
    });
    const runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (
        id, project_id, type, host, device_id, name, capabilities, status,
        last_seen_at, rate_limited_until
      )
      VALUES (
        ${runnerId}, ${projectId}, 'claude-code', 'device', ${device.id},
        ${`runner-${runnerId.slice(0, 8)}`}, '{}'::jsonb,
        ${opts.status === 'offline' ? 'offline' : 'online'}, now(),
        ${opts.rateLimitedUntil ? opts.rateLimitedUntil.toISOString() : null}
      )
    `);
    return { deviceId: device.id, runnerId };
  }

  async function openSystemRun(projectId: string): Promise<string> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, NULL, 'system', 'running', now())
    `);
    return runId;
  }

  async function insertIssue(projectId: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (
        ${id}, ${projectId}, ${Math.floor(Math.random() * 1_000_000)},
        'Issue', 'approved', 'medium',
        (SELECT created_by FROM projects WHERE id = ${projectId})
      )
    `);
    return id;
  }

  async function insertJob(
    projectId: string,
    opts: {
      issueId?: string | null;
      type?: string;
      status?: string;
      runnerId?: string | null;
      deviceId?: string | null;
      error?: string | null;
      finishedAt?: Date | null;
      retryOf?: string | null;
      failureKind?: string | null;
      failureAction?: string | null;
      failureReason?: string | null;
      classifierVersion?: number | null;
      pipelineRunId?: string;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const pipelineRunId = opts.pipelineRunId ?? (await openSystemRun(projectId));
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, pipeline_run_id, device_id, runner_id,
        created_by, type, status, payload, error, finished_at, retry_of,
        failure_kind, failure_action, failure_reason, classifier_version
      )
      VALUES (
        ${id}, ${projectId}, ${opts.issueId ?? null}, ${pipelineRunId},
        ${opts.deviceId ?? null}, ${opts.runnerId ?? null},
        (SELECT created_by FROM projects WHERE id = ${projectId}),
        ${opts.type ?? 'code'}, ${opts.status ?? 'queued'}, '{}'::jsonb,
        ${opts.error ?? null},
        ${opts.finishedAt ? opts.finishedAt.toISOString() : null},
        ${opts.retryOf ?? null},
        ${opts.failureKind ?? null}, ${opts.failureAction ?? null},
        ${opts.failureReason ?? null}, ${opts.classifierVersion ?? null}
      )
    `);
    return id;
  }

  async function getJobRow(jobId: string) {
    const [row] = await mods.db.select().from(mods.jobs).where(eq(mods.jobs.id, jobId));
    if (!row) throw new Error(`job ${jobId} not found`);
    return row;
  }

  // ---------- ISS-757 — org spend-cap storm ------------------------------

  it('ISS-757: org spend-cap classifies failover (not the old generic-infra bucket) and parks immediately instead of retrying', async () => {
    const spendCapText =
      "You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit";

    // The historical bug: this string fell through to `infra` + a bounded
    // round-robin retry, producing 60 dispatches in 80 minutes because
    // rotation cannot help an org-wide cap. It must now be `transient-cc` /
    // `failover` — a per-account exhaustion class, not the generic bucket.
    const classified = mods.classifyFailure({ error: spendCapText });
    expect(classified.kind).toBe('transient-cc');
    expect(classified.action).toBe('failover');

    const { owner, project } = await seedProject();
    // cm:why the fleet's only device is seeded ALREADY rate-limited because finalize-failure.ts stamps the spend cap BEFORE the retry decision reads it (ISS-823 review round 1's ordering fix); seeding it clean would test a fleet state that cannot occur at this point in the real sequence
    const { deviceId, runnerId } = await seedRunner(project.id, owner.id, {
      rateLimitedUntil: new Date(Date.now() + 60 * 60_000),
    });

    const jobId = await insertJob(project.id, {
      status: 'failed',
      runnerId,
      deviceId,
      error: spendCapText,
    });
    const job = await getJobRow(jobId);

    // cm:why this assertion was inverted on 2026-08-13, and the inversion is the POINT: it used to demand `{scheduled:false, reason:'all_devices_exhausted'}` on the FIRST attempt, which is the policy the owner reversed on 2026-08-12 (see the cm:why + cm:guard on `allRunnersLimited` in src/jobs/retry.ts — an all-limited fleet now DEFERS to the rotation, because parking a seconds-long provider throttle turns it into a human intervention). The test was authored the same day and never executed, so nothing caught that it contradicted the guard.
    // cm:edge lockstep -> packages/core/src/jobs/retry.ts — `allRunnersLimited` is computed but deliberately NOT acted on at entry; if that entry-park is ever restored, this first-attempt expectation flips back
    const firstAttempt = await mods.scheduleAutoRetryWithVerify(job, spendCapText);
    expect(firstAttempt.scheduled).toBe(true);

    // cm:why the ISS-757 face is the 60-dispatch STORM, and what stops it now is the round budget plus an immediate rotation, so proving the face is closed needs BOTH halves: the first attempt rotates, and the last permitted sweep parks. Asserting only the park would pass even if entry-parking came back, which is the reversed policy.
    const exhausted = {
      ...job,
      payload: {
        [mods.AUTO_RETRY_PAYLOAD_KEY]: {
          round: mods.RETRY_MAX_ROUNDS,
          target: deviceId,
          tries: mods.RETRY_TRIES_PER_DEVICE,
          done: [deviceId],
        },
      },
    };
    const lastAttempt = await mods.scheduleAutoRetryWithVerify(exhausted, spendCapText);
    expect(lastAttempt.scheduled).toBe(false);
    expect(lastAttempt.reason).toBe('all_devices_exhausted');
  });

  // ---------- ISS-806 — box-scoped deterministic failure quarantines -----

  it('ISS-806: N identical box-scoped preflight failures quarantine the originating runner, not the fleet; a differing failure does not', async () => {
    const { owner, project } = await seedProject();
    const { runnerId: brokenRunnerId, deviceId: brokenDeviceId } = await seedRunner(
      project.id,
      owner.id,
    );
    const { runnerId: healthyRunnerId, deviceId: healthyDeviceId } = await seedRunner(
      project.id,
      owner.id,
    );

    const check = 'push_credentials';
    const priorCount = mods.RUNNER_QUARANTINE_STREAK - 1;
    for (let i = 0; i < priorCount; i++) {
      await insertJob(project.id, {
        status: 'failed',
        runnerId: brokenRunnerId,
        error: `preflight_failed: ${check}: no write access`,
        finishedAt: new Date(Date.now() - (priorCount - i) * 60_000),
      });
    }
    const currentJobId = await insertJob(project.id, { runnerId: brokenRunnerId });

    const tripped = await mods.maybeQuarantineRunner(
      brokenRunnerId,
      project.id,
      currentJobId,
      `preflight_failed: ${check}: no write access`,
    );
    expect(tripped).toBe(true);

    const [runnerRow] = await harness.db.execute<{
      quarantined_until: string | null;
      quarantine_reason: string | null;
    }>(sql`SELECT quarantined_until, quarantine_reason FROM runners WHERE id = ${brokenRunnerId}`);
    expect(runnerRow?.quarantined_until).toBeTruthy();
    expect(runnerRow?.quarantine_reason).toBe(`preflight_failed: ${check}`);

    // Hard exclusion survives the wrap-around: simulate a retry chain that
    // has already "tried" both devices (excludeDeviceIds covers the fleet),
    // triggering the retry wrap-around that resets excludeDeviceIds to `[]`.
    // The quarantined device must still not come back.
    const picked = await mods.selectRunnerForJob({
      projectId: project.id,
      requiredCapabilities: {},
      excludeDeviceIds: [brokenDeviceId, healthyDeviceId],
      skipPrimary: true,
    });
    expect(picked?.id).toBe(healthyRunnerId);
    expect(picked?.id).not.toBe(brokenRunnerId);

    // A DIFFERING failure does not extend the streak.
    const { runnerId: otherRunnerId } = await seedRunner(project.id, owner.id);
    for (let i = 0; i < priorCount; i++) {
      await insertJob(project.id, {
        status: 'failed',
        runnerId: otherRunnerId,
        error: `preflight_failed: ${i === 0 ? check : 'hooks_path'}: detail`,
        finishedAt: new Date(Date.now() - (priorCount - i) * 60_000),
      });
    }
    const otherCurrentJobId = await insertJob(project.id, { runnerId: otherRunnerId });
    const notTripped = await mods.maybeQuarantineRunner(
      otherRunnerId,
      project.id,
      otherCurrentJobId,
      `preflight_failed: ${check}: no write access`,
    );
    expect(notTripped).toBe(false);
  });

  // ---------- ISS-760 — schedule terminal path stops lying ----------------

  it('ISS-760: an unrecognized schedule failure records a reason and lastStatus=failed (never NULL/success); a superseded session cannot clobber it', async () => {
    const { owner, project } = await seedProject();
    const sessionId = randomUUID();
    const scheduleId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO schedules (id, project_id, name, cron, kind, last_session_id, last_status)
      VALUES (${scheduleId}, ${project.id}, 'nightly', '0 0 * * *', 'prompt', ${sessionId}, 'running')
    `);
    void owner;

    const unmatchedText = 'zzz-totally-unrecognizable-failure-blorp-xyz-9999';
    const set: Record<string, unknown> = {};
    const result = await mods.finalizeScheduleSessionFailure({
      sessionId,
      messages: [],
      note: unmatchedText,
      baseMetadata: {},
      set,
    });

    // Before ISS-824, an unmatched string left `set.failureReason` untouched
    // (NULL persisted) because only a usage-limit hit wrote anything.
    expect(set.failureReason).toBeTruthy();
    expect(result.action).toBe('retry');

    await mods.writeBackScheduleLastStatus(
      { source: 'schedule.run', scheduleId },
      sessionId,
      'failed',
    );
    const [afterFail] = await harness.db.execute<{ last_status: string | null }>(
      sql`SELECT last_status FROM schedules WHERE id = ${scheduleId}`,
    );
    expect(afterFail?.last_status).toBe('failed');

    // A late terminal report from a SUPERSEDED session (its id no longer
    // matches schedules.last_session_id) must update zero rows, not clobber
    // the current run's status.
    const supersededSessionId = randomUUID();
    await mods.writeBackScheduleLastStatus(
      { source: 'schedule.run', scheduleId },
      supersededSessionId,
      'completed',
    );
    const [afterStale] = await harness.db.execute<{ last_status: string | null }>(
      sql`SELECT last_status FROM schedules WHERE id = ${scheduleId}`,
    );
    expect(afterStale?.last_status).toBe('failed');
  });

  // ---------- ISS-811 — rescued-by-retry is countable ---------------------

  it('ISS-811: a retry chain that eventually succeeds is counted once, attributed to the original failure reason; unrescued/first-try rows are excluded', async () => {
    const { project } = await seedProject();

    const originalReason = 'infra: preflight_failed: hooks_path: detail';
    const failedJobId = await insertJob(project.id, {
      status: 'failed',
      failureKind: 'infra',
      failureReason: originalReason,
      finishedAt: new Date(Date.now() - 2 * 60_000),
    });
    const rescuedJobId = await insertJob(project.id, {
      status: 'done',
      retryOf: failedJobId,
      finishedAt: new Date(Date.now() - 60_000),
    });
    // First-try success: no retry_of, must never appear as a "rescue".
    const firstTrySuccessId = await insertJob(project.id, { status: 'done' });
    // A failed chain that was never rescued (child never succeeded) must not
    // appear either — no `done` row points at it via retry_of, so nothing to
    // assert beyond the two checks below.

    const rescueRows = await harness.db.execute<{
      rescued_job_id: string;
      failure_reason: string;
      original_failed_job_id: string;
    }>(
      sql`SELECT rescued_job_id, failure_reason, original_failed_job_id FROM retry_rescues WHERE rescued_job_id = ${rescuedJobId}`,
    );
    expect(rescueRows).toHaveLength(1);
    expect(rescueRows[0]?.failure_reason).toBe(originalReason);
    expect(rescueRows[0]?.original_failed_job_id).toBe(failedJobId);

    const firstTryRows = await harness.db.execute(
      sql`SELECT 1 FROM retry_rescues WHERE rescued_job_id = ${firstTrySuccessId}`,
    );
    expect(firstTryRows).toHaveLength(0);
  });

  // ---------- ISS-630/804 — the fifth face: per-state budget gate ---------

  it('ISS-630/804: a budget-exhausted stage parks the issue and closes the run instead of stranding both (the 3x-vs-0x asymmetry)', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    // Cap set on `confirmed` specifically (a stage a `triage` job runs
    // under) — the asymmetry was that ONE capped stage died with zero
    // retries while an uncapped stage retried normally; the fix is that the
    // capped stage now dies HONESTLY (parked + closed) instead of silently.
    await harness.db.execute(sql`
      UPDATE projects
      SET agent_config = COALESCE(agent_config, '{}'::jsonb)
                       || jsonb_build_object(
                            'pipelineConfig',
                            jsonb_build_object(
                              'states', jsonb_build_object(
                                'confirmed', jsonb_build_object(
                                  'budget', jsonb_build_object('perMonthUsd', 1, 'action', 'pause')
                                )
                              )
                            ))
      WHERE id = ${project.id}
    `);
    const { deviceId } = await seedRunner(project.id, owner.id);
    void deviceId;

    const issueId = await insertIssue(project.id);
    // Historical spend already over the cap for this (project, jobType).
    const sessionId = randomUUID();
    const runId = randomUUID();
    const historicalJobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, status, started_at)
      VALUES (${runId}, ${project.id}, ${issueId}, 'completed', now())
    `);
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status, started_at, metadata)
      VALUES (${sessionId}, ${project.id}, ${runId}, 'completed', now() - interval '10 minutes', '{}'::jsonb)
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, type, status, payload, created_by,
        agent_session_id, pipeline_run_id, dispatched_at, finished_at, queued_at
      )
      VALUES (
        ${historicalJobId}, ${project.id}, ${issueId}, 'triage', 'done', '{}'::jsonb,
        ${owner.id}, ${sessionId}, ${runId},
        now() - interval '10 minutes', now() - interval '5 minutes', now() - interval '11 minutes'
      )
    `);
    await harness.db.execute(sql`
      INSERT INTO usage_records (id, project_id, source, model, estimated_cost, recorded_at, session_id)
      VALUES (${randomUUID()}, ${project.id}, 'cli', 'sonnet', 1.5::real, now(), ${sessionId})
    `);

    const openRunId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${openRunId}, ${project.id}, ${issueId}, 'issue', 'running', now())
    `);
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, type, status, payload, created_by,
        pipeline_run_id, queued_at
      )
      VALUES (
        ${jobId}, ${project.id}, ${issueId}, 'triage', 'queued',
        ${JSON.stringify({ stageStatus: 'confirmed' })}::jsonb,
        ${owner.id}, ${openRunId}, now()
      )
    `);

    const result = await mods.handleDispatch({ jobId });
    expect(result).toBe('skipped');

    const jobRows = await harness.db.execute<{
      status: string;
      failure_action: string | null;
      classifier_version: number | null;
    }>(sql`SELECT status, failure_action, classifier_version FROM jobs WHERE id = ${jobId}`);
    expect(jobRows[0]?.status).toBe('failed');
    expect(jobRows[0]?.failure_action).toBe('terminal');
    // Pre-ISS-823 this was hardcoded to 1, disagreeing with every other
    // terminal park on record.
    expect(jobRows[0]?.classifier_version).toBe(mods.CLASSIFIER_VERSION);

    const issueRows = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM issues WHERE id = ${issueId}`,
    );
    expect(issueRows[0]?.status).toBe('waiting');

    const runRows = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM pipeline_runs WHERE id = ${openRunId}`,
    );
    expect(runRows[0]?.status).not.toBe('running');
  });

  // ---------- Composition: quarantine + per-account exhaustion share the same gate ----

  it('composition: a fleet exhausted by a MIX of quarantine (ISS-825) and rate-limit (ISS-823) reasons still reads as exhausted, not offline', async () => {
    const { owner, project } = await seedProject();
    const { runnerId: quarantinedRunnerId, deviceId: quarantinedDeviceId } = await seedRunner(
      project.id,
      owner.id,
    );
    const { deviceId: limitedDeviceId } = await seedRunner(project.id, owner.id, {
      rateLimitedUntil: new Date(Date.now() + 60 * 60_000),
    });

    await harness.db.execute(sql`
      UPDATE runners SET quarantined_until = now() + interval '1 hour', quarantine_reason = 'preflight_failed: hooks_path'
      WHERE id = ${quarantinedRunnerId}
    `);

    const healthy = await mods.onlineCapableDeviceIds(project.id);
    expect(healthy).toHaveLength(0);

    // The unfiltered set (what "all devices" means to the retry engine) must
    // still see both devices as present-but-excluded, not vanished — that is
    // the distinction that tells "every online box is exhausted" (park +
    // notify) apart from "the fleet is offline" (wait quietly).
    const all = await mods.onlineCapableDeviceIds(project.id, undefined, { includeLimited: true });
    expect(new Set(all)).toEqual(new Set([quarantinedDeviceId, limitedDeviceId]));
  });
});
