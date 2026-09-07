/**
 * Shared fixture for the two `unaudited_transitions` suites (ISS-884, ISS-943).
 *
 * They split by proposition, not by convenience: one asserts what a hand on the
 * database PRODUCES, the other asserts that ordinary traffic produces NOTHING.
 * Both need the same project / issue / run / job / session fixture and the same
 * `detected()` read, and neither is small — a single file put its `describe`
 * body 125 lines over the 150-line function budget.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { setupTestDatabase, type TestDatabase } from './db.js';
import { createTestProject, createTestUser } from './factories.js';
import { truncateAll } from './truncate.js';

export type UnauditedMods = {
  applyKernelTransition: typeof import('../../src/lifecycle/transition.js').applyKernelTransition;
  withKernelMarker: typeof import('../../src/db/kernel-marker.js').withKernelMarker;
  pauseRun: typeof import('../../src/pipeline/run-pause.js').pauseRun;
  resumeRun: typeof import('../../src/pipeline/run-pause.js').resumeRun;
  startJobForMaster: typeof import('../../src/devices/claim.js').startJobForMaster;
  resumeHeldJob: typeof import('../../src/jobs/resume-job.js').resumeHeldJob;
};

export type Detected = {
  entity: string;
  entity_id: string;
  project_id: string;
  issue_id: string | null;
  from_status: string | null;
  to_status: string;
  db_user: string;
};

export interface UnauditedFixture {
  harness: TestDatabase;
  mods: UnauditedMods;
  /** Per-test ids, replaced by every `reset()`. */
  ids: { projectId: string; ownerId: string; issueId: string; runId: string };
  reset(): Promise<void>;
  insertJob(
    status?: string,
    opts?: { runId?: string | null; issueId?: string | null; payload?: unknown; type?: string },
  ): Promise<string>;
  insertSession(status?: string, opts?: { runId?: string; metadata?: unknown }): Promise<string>;
  insertIssuelessRun(): Promise<string>;
  detected(): Promise<Detected[]>;
}

export async function createUnauditedFixture(): Promise<UnauditedFixture> {
  const harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const [transition, marker, runPause, claim, resume] = await Promise.all([
    import('../../src/lifecycle/transition.js'),
    import('../../src/db/kernel-marker.js'),
    import('../../src/pipeline/run-pause.js'),
    import('../../src/devices/claim.js'),
    import('../../src/jobs/resume-job.js'),
  ]);
  const ids = { projectId: '', ownerId: '', issueId: '', runId: '' };

  return {
    harness,
    ids,
    mods: {
      applyKernelTransition: transition.applyKernelTransition,
      withKernelMarker: marker.withKernelMarker,
      pauseRun: runPause.pauseRun,
      resumeRun: runPause.resumeRun,
      startJobForMaster: claim.startJobForMaster,
      resumeHeldJob: resume.resumeHeldJob,
    },

    async reset() {
      await truncateAll(harness.db);
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      ids.ownerId = owner.id;
      ids.projectId = project.id;
      ids.issueId = randomUUID();
      ids.runId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO issues (id, project_id, created_by_id, title, description, status)
        VALUES (${ids.issueId}, ${ids.projectId}, ${ids.ownerId}, 'ISS-943 fixture', 'fixture', 'open')
      `);
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
        VALUES (${ids.runId}, ${ids.projectId}, ${ids.issueId}, 'issue', 'running', now())
      `);
    },

    // cm:guard `jobs_active_unique` is on (issue_id, type) for ACTIVE rows, so two fixture jobs on one issue must differ in `type` or one insert fails on a constraint that has nothing to do with what the test is asserting.
    async insertJob(status = 'queued', opts = {}) {
      const id = randomUUID();
      const run = opts.runId === undefined ? ids.runId : opts.runId;
      const issue = opts.issueId === undefined ? ids.issueId : opts.issueId;
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status,
                          payload, queued_at)
        VALUES (${id}, ${ids.projectId}, ${issue}, ${run}, ${ids.ownerId}, ${opts.type ?? 'code'},
                ${status}, ${JSON.stringify(opts.payload ?? {})}::jsonb, now())
      `);
      return id;
    },

    // cm:guard `agent_sessions.pipeline_run_id` is NOT NULL, so a session cannot be created without a run — which is why the `metadata.issueId` resolution path is reached through `insertIssuelessRun`, never through a null run.
    async insertSession(status = 'idle', opts = {}) {
      const id = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, status, metadata)
        VALUES (${id}, ${ids.projectId}, ${ids.ownerId}, ${opts.runId ?? ids.runId}, ${status},
                ${JSON.stringify(opts.metadata ?? {})}::jsonb)
      `);
      return id;
    },

    /** A run with no issue — the `pm`/system shape. */
    async insertIssuelessRun() {
      const id = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
        VALUES (${id}, ${ids.projectId}, NULL, 'pm', 'running', now())
      `);
      return id;
    },

    async detected() {
      const rows = await harness.db.execute(sql`
        SELECT entity, entity_id, project_id, issue_id, from_status, to_status, db_user
        FROM unaudited_transitions ORDER BY detected_at
      `);
      return rows as unknown as Detected[];
    },
  };
}
