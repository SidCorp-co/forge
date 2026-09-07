/**
 * ISS-940 — merged code under a live status, against a real Postgres.
 *
 * Two passes decide this shape and both decide it in SQL: the reconciler's
 * rescue must refuse to re-dispatch an issue carrying a merge mark, and
 * `detectOwedCloses` must be what tells a human instead. Every control that
 * separates the shape from its near-misses — a live job, a running run, a
 * reopened issue, a terminal one — is a clause in a SELECT, and against the
 * unit suite's mocked `db.execute` none of those clauses can fail.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('ISS-940 shipped-but-never-closed (real Postgres)', () => {
  let harness: TestDatabase;
  let userId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);
    userId = user.id;
  });

  /** The ISS-920 / ISS-931 shape: merged and deployed, the closing run gone. */
  async function seed(opts: {
    status?: string;
    mergedAgo?: string | null;
    idle?: string;
    jobStatus?: string;
    runStatus?: string;
  }): Promise<{ projectId: string; issueId: string }> {
    const project = await createTestProject(harness.db, userId);
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = ${JSON.stringify({ pipelineConfig: { enabled: true } })}::jsonb
      WHERE id = ${project.id}
    `);

    const issueId = randomUUID();
    const merged =
      opts.mergedAgo === null
        ? sql`NULL`
        : sql`now() - interval '${sql.raw(opts.mergedAgo ?? '2 days')}'`;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id, merged_at, updated_at)
      VALUES (${issueId}, ${project.id}, 'shipped specimen', ${opts.status ?? 'open'},
              ${userId}, ${merged}, now() - interval '${sql.raw(opts.idle ?? '30 minutes')}')
    `);

    if (opts.runStatus || opts.jobStatus) {
      const runId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, current_step)
        VALUES (${runId}, ${project.id}, ${issueId}, 'issue', ${opts.runStatus ?? 'completed'}, 'open')
      `);
      if (opts.jobStatus) {
        await harness.db.execute(sql`
          INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status, created_at)
          VALUES (${randomUUID()}, ${project.id}, ${issueId}, ${runId}, ${userId},
                  'drive', ${opts.jobStatus}, now() - interval '1 hour')
        `);
      }
    }

    return { projectId: project.id, issueId };
  }

  async function detect(projectId: string): Promise<{ detected: number; notified: number }> {
    const { detectOwedCloses } = await import('../../src/pipeline/stranded-issues.js');
    return detectOwedCloses(new Date(), { projectId });
  }

  describe('the reconciler refuses to re-dispatch it', () => {
    it('rescues a stuck `open` issue that never shipped', async () => {
      await seed({ mergedAgo: null });
      const { runReconcilerOnce } = await import('../../src/pipeline/reconciler.js');

      expect((await runReconcilerOnce()).rescued).toBe(1);
    });

    // cm:guard this is the ISS-920 / ISS-931 case and the ONLY difference from the test above is the merge mark — the two run the same seed so a deleted `merged_at IS NULL` clause cannot hide behind a second variable
    it('leaves a stuck `open` issue that already carries a merge mark', async () => {
      const { issueId } = await seed({});
      const { runReconcilerOnce } = await import('../../src/pipeline/reconciler.js');

      expect((await runReconcilerOnce()).rescued).toBe(0);
      const jobs = await harness.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM jobs WHERE issue_id = ${issueId}`,
      );
      expect(jobs[0]?.n).toBe(0);
    });
  });

  describe('the sweep surfaces it instead', () => {
    it('detects merged code under a live status with nothing running', async () => {
      const { projectId, issueId } = await seed({});

      expect(await detect(projectId)).toEqual({ detected: 1, notified: 1 });

      const rows = await harness.db.execute<{ resolution_key: string; type: string }>(
        sql`SELECT resolution_key, type FROM notifications WHERE issue_id = ${issueId}`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.resolution_key).toBe(`issue:${issueId}:owed-close`);
      expect(rows[0]?.type).toBe('issue_stranded');
    });

    it('says nothing twice for one strand', async () => {
      const { projectId } = await seed({});

      expect((await detect(projectId)).notified).toBe(1);
      expect((await detect(projectId)).notified).toBe(0);
    });

    it('leaves an issue whose merge mark is still inside the grace window', async () => {
      const { projectId } = await seed({ mergedAgo: '1 hour' });

      expect(await detect(projectId)).toEqual({ detected: 0, notified: 0 });
    });

    // cm:guard these two arms are what separate this shape from a REOPENED issue, which legitimately carries the mark of its first landing while real work is in flight — delete either clause and the alarm fires on every issue that has ever shipped
    it('leaves an issue under a running pipeline run', async () => {
      const { projectId } = await seed({ status: 'in_progress', runStatus: 'running' });

      expect(await detect(projectId)).toEqual({ detected: 0, notified: 0 });
    });

    // cm:guard the run is PAUSED, not running, so only the job arm can exclude this row — a queued step under a paused run is the one live-work shape the run arm cannot see (a live job under a TERMINAL run is not representable: the close-cascade trigger cancels it at insert)
    it('leaves an issue with a queued job under a paused run', async () => {
      const { projectId } = await seed({
        status: 'in_progress',
        runStatus: 'paused',
        jobStatus: 'queued',
      });

      expect(await detect(projectId)).toEqual({ detected: 0, notified: 0 });
    });

    it('leaves a closed issue — the mark and the status agree', async () => {
      const { projectId } = await seed({ status: 'closed' });

      expect(await detect(projectId)).toEqual({ detected: 0, notified: 0 });
    });

    it('leaves a dropped issue', async () => {
      const { projectId } = await seed({ status: 'dropped' });

      expect(await detect(projectId)).toEqual({ detected: 0, notified: 0 });
    });

    it('says nothing about an issue that never carried a mark', async () => {
      const { projectId } = await seed({ mergedAgo: null });

      expect(await detect(projectId)).toEqual({ detected: 0, notified: 0 });
    });
  });

  describe('the alarm is cleared by the close it asked for', () => {
    it('resolves the owed-close notification on a terminal placement', async () => {
      const { projectId, issueId } = await seed({});
      await detect(projectId);

      const { resolveNotifications } = await import('../../src/notifications/auto-resolve.js');
      const { owedCloseResolutionKey } = await import('../../src/pipeline/stranded-issues.js');
      expect(await resolveNotifications(owedCloseResolutionKey(issueId))).toBe(1);

      const rows = await harness.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM notifications
            WHERE issue_id = ${issueId} AND resolved_at IS NOT NULL`,
      );
      expect(rows[0]?.n).toBe(1);
    });
  });
});
