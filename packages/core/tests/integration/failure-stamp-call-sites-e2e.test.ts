/**
 * ISS-812 [Epic], AC1/AC3 — the terminal writes that were still deciding the
 * class for themselves. The composed walk in `failure-taxonomy-policy-e2e`
 * covers the five original faces; this file covers the sixth shape found by
 * reading live rows on 2026-08-26: a write that persists a kind it picked by
 * hand, with no action and no taxonomy version, so the row is invisible to
 * every action-keyed query and reads as five-version-old semantics.
 *
 * Measured on forge-beta over 60 days: 17 `runner_unsupported_type:claude-code`
 * rows (kinetrak, 2026-08-20) with failure_action, classifier_version and
 * finished_at all NULL, plus 32 kill-gate rows frozen at classifier_version 3.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as DbClient from '../../src/db/client.js';
import type * as JobsDispatcher from '../../src/jobs/dispatcher.js';
import type * as JobsHandleResumeFailed from '../../src/jobs/handle-resume-failed.js';
import type * as PipelineFailureClassifier from '../../src/pipeline/failure-classifier.js';
import type * as PipelineHooks from '../../src/pipeline/hooks.js';
import type * as RunnersBootstrap from '../../src/runners/bootstrap.js';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  CLASSIFIER_VERSION: typeof PipelineFailureClassifier.CLASSIFIER_VERSION;
  handleDispatch: typeof JobsDispatcher.handleDispatch;
  markResumeAborted: typeof JobsHandleResumeFailed.markResumeAborted;
  bootstrapRunnerAdapters: typeof RunnersBootstrap.bootstrapRunnerAdapters;
  hooks: typeof PipelineHooks.hooks;
  db: typeof DbClient.db;
};

type JobFailureRow = {
  status: string;
  failure_kind: string | null;
  failure_action: string | null;
  failure_reason: string | null;
  classifier_version: number | null;
  finished_at: string | null;
};

describe('ISS-812 AC1/AC3 — a terminal write persists the action and the version in force', () => {
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

    // cm:guard import these SEQUENTIALLY, never with Promise.all — resolving these graphs concurrently deadlocks the module runner, and a wedged beforeAll reports its tests as `skipped` rather than failed, so the suite looks green while never having run (measured 2026-08-13 on failure-taxonomy-policy-e2e, which sat wedged from the day it was written)
    const classifierMod = await import('../../src/pipeline/failure-classifier.js');
    const dispatcherMod = await import('../../src/jobs/dispatcher.js');
    const resumeMod = await import('../../src/jobs/handle-resume-failed.js');
    const hooksMod = await import('../../src/pipeline/hooks.js');
    const bootstrapMod = await import('../../src/runners/bootstrap.js');
    const dbMod = await import('../../src/db/client.js');
    mods = {
      CLASSIFIER_VERSION: classifierMod.CLASSIFIER_VERSION,
      handleDispatch: dispatcherMod.handleDispatch,
      markResumeAborted: resumeMod.markResumeAborted,
      bootstrapRunnerAdapters: bootstrapMod.bootstrapRunnerAdapters,
      hooks: hooksMod.hooks,
      db: dbMod.db,
    };
    // cm:why the real adapter registry is bootstrapped rather than stubbed because the dispatcher looks the adapter up BEFORE the runner/job-type gate: with an empty registry every dispatch skips one branch earlier and the gate under test is never reached
    mods.bootstrapRunnerAdapters();
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    mods.hooks.reset();
  });

  async function readFailure(jobId: string): Promise<JobFailureRow> {
    const rows = await harness.db.execute<JobFailureRow>(sql`
      SELECT status, failure_kind, failure_action, failure_reason, classifier_version, finished_at
      FROM jobs WHERE id = ${jobId}
    `);
    const row = rows[0];
    if (!row) throw new Error(`job ${jobId} not found`);
    return row;
  }

  // cm:why the pair is (antigravity runner, `drive` job) because that mismatch is PERMANENT by design — RUNNER_CAPABILITIES excludes `drive` from antigravity on purpose, so this fixture cannot rot into a supported pair the way the kinetrak incident's (claude-code, drive) did once `drive` was added
  it('the runner/job-type gate records the classifier verdict — kind, action, version and finishedAt, not a hand-written kind', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id, { status: 'online' });
    await harness.db.execute(sql`
      INSERT INTO runners (
        id, project_id, type, host, device_id, name, capabilities, status, last_seen_at
      )
      VALUES (
        ${randomUUID()}, ${project.id}, 'antigravity', 'device', ${device.id},
        'antigravity-box', '{}'::jsonb, 'online', now()
      )
    `);

    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${project.id}, NULL, 'system', 'running', now())
    `);
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, pipeline_run_id, created_by, type, status, payload, queued_at
      )
      VALUES (
        ${jobId}, ${project.id}, NULL, ${runId},
        ${owner.id}, 'drive', 'queued', '{}'::jsonb, now()
      )
    `);

    const result = await mods.handleDispatch({ jobId });
    expect(result).toBe('skipped');

    const row = await readFailure(jobId);
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toBe('runner_unsupported_type:antigravity');
    expect(row.failure_kind).toBe('code');
    // cm:why asserting 'terminal' is not asserting a behaviour change — deriveActionFromKind already resolved a `code` row to terminal; what is new is that the row SAYS so, which is the only way an action-keyed query or metric can see it
    expect(row.failure_action).toBe('terminal');
    expect(row.classifier_version).toBe(mods.CLASSIFIER_VERSION);
    // cm:why finished_at is asserted because pipeline_run_step_durations emits one row per FINISHED job, so a failed row without it is absent from step analytics entirely — all 17 live kinetrak rows are
    expect(row.finished_at).not.toBeNull();
  });

  it('the resume-abort tail stamps the same four columns instead of freezing the version at 3', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${project.id}, NULL, 'system', 'running', now())
    `);
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, pipeline_run_id, created_by, type, status,
        payload, error, finished_at
      )
      VALUES (
        ${jobId}, ${project.id}, NULL, ${runId}, ${owner.id}, 'code', 'failed',
        '{}'::jsonb, '[RESUME_FAILED] session not found', now()
      )
    `);

    const updated = await mods.markResumeAborted(jobId);
    expect(updated?.failureReason).toBe('resume_failed');
    expect(updated?.failureKind).toBe('code');
    expect(updated?.failureAction).toBe('terminal');
    expect(updated?.classifierVersion).toBe(mods.CLASSIFIER_VERSION);

    const row = await readFailure(jobId);
    expect(row.classifier_version).toBe(mods.CLASSIFIER_VERSION);
    expect(row.failure_action).toBe('terminal');
  });
});
