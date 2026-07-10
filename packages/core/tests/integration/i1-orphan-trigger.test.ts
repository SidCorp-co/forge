/**
 * ISS-448 (ISS-442 C2, invariant I1) — DB backstop trigger + orphan backfill.
 *
 * Exercises migration 0113 (trigger `enforce_no_active_child_under_terminal_run`)
 * and 0114 (one-shot backfill) against real Postgres:
 *
 *  - ALARM MODE: an active child (jobs / agent_sessions) written under a TERMINAL
 *    pipeline_run is auto-cancelled (terminal status + failure_reason) and audited
 *    in kernel_transitions — the write succeeds (no hard-reject in Phase 1).
 *  - A legitimate in-flight child under an ACTIVE run is left untouched.
 *  - BACKFILL: the one-shot sweep cancels pre-existing orphans (simulated by
 *    disabling the trigger) while leaving legitimate in-flight rows alone.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('ISS-448 I1 orphan trigger + backfill', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedProject(): Promise<{ ownerId: string; projectId: string }> {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    return { ownerId: owner.id, projectId: project.id };
  }

  async function insertRun(projectId: string, status: string): Promise<string> {
    const id = randomUUID();
    const finishedAt =
      status === 'running' || status === 'paused' ? null : new Date().toISOString();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at)
      VALUES (${id}, ${projectId}, 'system', ${status}, now(), ${finishedAt})
    `);
    return id;
  }

  async function insertJob(projectId: string, runId: string, status: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, type, status, payload, pipeline_run_id, created_by)
      VALUES (
        ${id}, ${projectId}, 'plan', ${status}, '{}'::jsonb, ${runId},
        (SELECT created_by FROM projects WHERE id = ${projectId})
      )
    `);
    return id;
  }

  async function insertSession(projectId: string, runId: string, status: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, status, pipeline_run_id)
      VALUES (${id}, ${projectId}, ${status}, ${runId})
    `);
    return id;
  }

  async function jobRow(id: string) {
    const rows = await harness.db.execute<{ status: string; failure_reason: string | null }>(sql`
      SELECT status, failure_reason FROM jobs WHERE id = ${id}
    `);
    return rows[0] as { status: string; failure_reason: string | null };
  }

  async function sessionRow(id: string) {
    const rows = await harness.db.execute<{ status: string; failure_reason: string | null }>(sql`
      SELECT status, failure_reason FROM agent_sessions WHERE id = ${id}
    `);
    return rows[0] as { status: string; failure_reason: string | null };
  }

  async function auditCount(entityId: string, source: string): Promise<number> {
    const rows = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM kernel_transitions
      WHERE entity_id = ${entityId} AND source = ${source}
        AND reason = 'orphan_under_terminal_run'
    `);
    return Number((rows[0] as { n: number }).n);
  }

  describe('trigger — alarm mode (no hard reject)', () => {
    it('auto-cancels a job INSERTed active under a terminal run', async () => {
      const { projectId } = await seedProject();
      const run = await insertRun(projectId, 'completed');
      // Insert succeeds (no throw) but the row lands already cancelled.
      const job = await insertJob(projectId, run, 'queued');

      const row = await jobRow(job);
      expect(row.status).toBe('cancelled');
      expect(row.failure_reason).toBe('orphan_under_terminal_run');
      expect(await auditCount(job, 'i1_trigger')).toBe(1);
    });

    it('auto-cancels (cancelled_stale) a session INSERTed active under a terminal run', async () => {
      const { projectId } = await seedProject();
      const run = await insertRun(projectId, 'failed');
      const session = await insertSession(projectId, run, 'running');

      const row = await sessionRow(session);
      expect(row.status).toBe('cancelled_stale');
      expect(row.failure_reason).toBe('orphan_under_terminal_run');
      expect(await auditCount(session, 'i1_trigger')).toBe(1);
    });

    it('auto-cancels on UPDATE when the parent run is already terminal', async () => {
      const { projectId } = await seedProject();
      // Seed the job while the run is still active so it lands legitimately...
      const run = await insertRun(projectId, 'running');
      const job = await insertJob(projectId, run, 'running');
      expect((await jobRow(job)).status).toBe('running');

      // ...then close the run terminal and touch the job (e.g. a heartbeat).
      await harness.db.execute(sql`
        UPDATE pipeline_runs SET status = 'completed', finished_at = now() WHERE id = ${run}
      `);
      await harness.db.execute(sql`
        UPDATE jobs SET status = 'running' WHERE id = ${job}
      `);

      const row = await jobRow(job);
      expect(row.status).toBe('cancelled');
      expect(row.failure_reason).toBe('orphan_under_terminal_run');
    });

    it('leaves a legitimate in-flight child under an ACTIVE run untouched', async () => {
      const { projectId } = await seedProject();
      const run = await insertRun(projectId, 'running');
      const job = await insertJob(projectId, run, 'queued');
      const session = await insertSession(projectId, run, 'idle');

      expect((await jobRow(job)).status).toBe('queued');
      expect((await sessionRow(session)).status).toBe('idle');
      expect(await auditCount(job, 'i1_trigger')).toBe(0);
    });

    it('does not touch terminal writes (cascade / finalize path)', async () => {
      const { projectId } = await seedProject();
      const run = await insertRun(projectId, 'completed');
      // Writing an already-terminal job under a terminal run is the normal
      // cascade outcome — the trigger must not rewrite it or audit it.
      const job = await insertJob(projectId, run, 'done');

      expect((await jobRow(job)).status).toBe('done');
      expect(await auditCount(job, 'i1_trigger')).toBe(0);
    });
  });

  describe('backfill (migration 0114 logic)', () => {
    it('cancels pre-existing orphans and leaves legitimate in-flight rows alone', async () => {
      const { projectId } = await seedProject();
      const terminalRun = await insertRun(projectId, 'completed');
      const activeRun = await insertRun(projectId, 'running');

      // Simulate orphans that pre-date the trigger by disabling it for the inserts.
      await harness.db.execute(
        sql`ALTER TABLE jobs DISABLE TRIGGER trg_jobs_no_active_under_terminal_run`,
      );
      await harness.db.execute(
        sql`ALTER TABLE agent_sessions DISABLE TRIGGER trg_agent_sessions_no_active_under_terminal_run`,
      );
      const orphanJob = await insertJob(projectId, terminalRun, 'running');
      const orphanSession = await insertSession(projectId, terminalRun, 'queued');
      const liveJob = await insertJob(projectId, activeRun, 'running');
      const liveSession = await insertSession(projectId, activeRun, 'idle');
      await harness.db.execute(
        sql`ALTER TABLE jobs ENABLE TRIGGER trg_jobs_no_active_under_terminal_run`,
      );
      await harness.db.execute(
        sql`ALTER TABLE agent_sessions ENABLE TRIGGER trg_agent_sessions_no_active_under_terminal_run`,
      );

      // Run the same backfill statements as migration 0114, under the v3
      // failure taxonomy: 0115 remapped 'transient' → 'infra' (and swapped the
      // CHECK to code|infra|transient-cc|timeout), and 0118 rewrote the
      // trigger to assign 'infra' for orphans-under-terminal-run.
      await harness.db.execute(sql`
        UPDATE jobs j
        SET status = 'cancelled', failure_kind = 'infra',
            failure_reason = 'orphan_under_terminal_run',
            cancellation_requested = true, finished_at = COALESCE(j.finished_at, now())
        FROM pipeline_runs r
        WHERE j.pipeline_run_id = r.id
          AND j.status IN ('queued', 'dispatched', 'running')
          AND r.status IN ('completed', 'failed', 'cancelled')
      `);
      await harness.db.execute(sql`
        UPDATE agent_sessions s
        SET status = 'cancelled_stale', failure_reason = 'orphan_under_terminal_run',
            updated_at = now()
        FROM pipeline_runs r
        WHERE s.pipeline_run_id = r.id
          AND s.status IN ('idle', 'queued', 'running')
          AND r.status IN ('completed', 'failed', 'cancelled')
      `);

      // Orphans flipped to terminal...
      expect((await jobRow(orphanJob)).status).toBe('cancelled');
      expect((await jobRow(orphanJob)).failure_reason).toBe('orphan_under_terminal_run');
      expect((await sessionRow(orphanSession)).status).toBe('cancelled_stale');
      // ...legitimate in-flight rows under the active run untouched.
      expect((await jobRow(liveJob)).status).toBe('running');
      expect((await sessionRow(liveSession)).status).toBe('idle');
    });
  });
});
