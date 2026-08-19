/**
 * The result hop against a long-running autonomous job, on real Postgres.
 *
 * A driver that runs one job for hours emits no per-step job_events, so the
 * only thing standing between it and the reaper is that a declared phase
 * counts as progress. That is a claim about a SQL expression, and a mocked db
 * cannot observe it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('autonomous job liveness E2E', () => {
  let harness: TestDatabase;
  let projectId: string;
  let ownerId: string;
  let issueId: string;
  let runId: string;
  let jobId: string;
  let reapResultMisses: (now?: Date, scope?: { projectId?: string }) => Promise<unknown>;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    ({ reapResultMisses } = await import('../../src/jobs/loop-monitor.js'));
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  /** Dispatched three hours ago with no events since — quiet by every old measure. */
  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    const project = await createTestProject(harness.db, owner.id);
    projectId = project.id;
    issueId = randomUUID();
    runId = randomUUID();
    jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueId}, ${projectId}, 1, 'drive me', 'in_progress', ${ownerId})
    `);
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running', now() - interval '3 hours')
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, payload,
                        created_by, queued_at, dispatched_at)
      VALUES (${jobId}, ${projectId}, ${issueId}, ${runId}, 'drive', 'running', '{}'::jsonb,
              ${ownerId}, now() - interval '3 hours', now() - interval '3 hours')
    `);
  });

  async function declarePhase(phase: string, minutesAgo: number): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO phase_journal (id, project_id, run_id, issue_id, job_id, phase, attempt,
                                 source, started_at)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${issueId}, ${jobId}, ${phase}, 1,
              'agent', now() - make_interval(mins => ${minutesAgo}))
    `);
  }

  async function killRequested(): Promise<boolean> {
    const rows = await harness.db.execute(sql`
      SELECT kill_requested_at FROM jobs WHERE id = ${jobId}
    `);
    return rows[0]?.kill_requested_at != null;
  }

  it('reaps a job that has emitted nothing and declared nothing', async () => {
    await reapResultMisses(new Date(), { projectId });

    expect(await killRequested()).toBe(true);
  });

  // cm:guard the whole reason phase rows joined the quiet computation: this job is 3h old with zero job_events, which is exactly the shape the result hop was built to kill
  it('spares the same job when it declared a phase inside the quiet window', async () => {
    await declarePhase('code', 10);

    await reapResultMisses(new Date(), { projectId });

    expect(await killRequested()).toBe(false);
  });

  it('still reaps when the last declared phase is itself older than the window', async () => {
    await declarePhase('code', 200);

    await reapResultMisses(new Date(), { projectId });

    expect(await killRequested()).toBe(true);
  });

  // cm:guard phase rows must not become the ONLY term — a staged job declares no phases of its own, so a job whose events are recent has to survive on those alone
  it('spares a staged job on its job_events alone, with no phase rows anywhere', async () => {
    await harness.db.execute(sql`
      INSERT INTO job_events (id, job_id, kind, data, seq, ts)
      VALUES (${randomUUID()}, ${jobId}, 'progress', '{}'::jsonb, 1, now() - interval '5 minutes')
    `);

    await reapResultMisses(new Date(), { projectId });

    expect(await killRequested()).toBe(false);
  });
});
