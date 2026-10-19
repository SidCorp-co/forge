/**
 * ISS-1133 r3 — no job lands live under a run a close just ended.
 *
 * A job insert's foreign-key lock does not conflict with a close's UPDATE, so admission takes the
 * run row itself. Each case holds a close uncommitted on the run an admission is about to use,
 * waits until the admission is blocked on that row, then commits the close: the issue door must
 * land the job on a fresh open run, a door bound to that run must refuse by name, and a held
 * successor must not be written.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let token: string;
let ownerId: string;
let projectId: string;
let seq = 1200;

let insertAndEnqueueJob: typeof import('../../src/pipeline/enqueue-helper.js').insertAndEnqueueJob;
let holdJobForReason: typeof import('../../src/jobs/hold.js').holdJobForReason;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  ({ insertAndEnqueueJob } = await import('../../src/pipeline/enqueue-helper.js'));
  ({ holdJobForReason } = await import('../../src/jobs/hold.js'));
  const { signUserToken } = await import('../../src/auth/jwt.js');
  server = await startTestServer();
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  token = await signUserToken(ownerId);
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  projectId = (await createTestProject(harness.db, ownerId)).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
});

async function seedRun(kind: 'issue' | 'system'): Promise<{ issueId: string; runId: string }> {
  const issueId = randomUUID();
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
    VALUES (${issueId}, ${projectId}, ${seq++}, 'admitted as its run closes', 'in_progress', 'medium', ${ownerId})
  `);
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
    VALUES (${runId}, ${projectId}, ${kind === 'issue' ? issueId : null}, ${kind}, 'running')
  `);
  return { issueId, runId };
}

/** A close of `runId` written and held uncommitted until `commit()` is called. */
async function holdClose(runId: string): Promise<{ commit: () => Promise<void> }> {
  let written!: () => void;
  const isWritten = new Promise<void>((resolve) => {
    written = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = harness.db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE pipeline_runs SET status = 'cancelled', finished_at = now() WHERE id = ${runId}
    `);
    written();
    await released;
  });
  await isWritten;
  return {
    commit: async () => {
      release();
      await done;
    },
  };
}

/**
 * Resolves once a backend of this database is blocked taking a run row `FOR SHARE`: the admission
 * waiting behind the held close. Bounded, so an admission that never waits fails here by name.
 */
async function admissionWaitsOnTheRun(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query ILIKE '%pipeline_runs%FOR SHARE%'
    `);
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no admission is waiting on the run row the held close locks');
}

async function liveJobsUnderTerminalRuns(): Promise<number> {
  const rows = await harness.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM jobs j JOIN pipeline_runs r ON r.id = j.pipeline_run_id
     WHERE r.status NOT IN ('running', 'paused')
       AND j.status IN ('queued', 'dispatched', 'running', 'held')
  `);
  return rows[0]?.n ?? -1;
}

describe('a job admitted while its run is being closed', () => {
  it('the issue door lands the job on a fresh open run of the issue', async () => {
    const { issueId, runId } = await seedRun('issue');
    const close = await holdClose(runId);

    const request = fetch(`${server.baseUrl}/api/projects/${projectId}/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'smoke', issueId, payload: { promptString: 'admit me' } }),
    });
    try {
      await admissionWaitsOnTheRun();
    } finally {
      await close.commit();
    }
    const res = await request;

    expect(res.status).toBe(201);
    const job = (await res.json()) as { pipelineRunId: string };
    expect(job.pipelineRunId).not.toBe(runId);
    const runs = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM pipeline_runs WHERE id = ${job.pipelineRunId}`,
    );
    expect(runs[0]?.status).toBe('running');
    expect(await liveJobsUnderTerminalRuns()).toBe(0);
  });

  it('a door bound to that run refuses it by name and writes no job', async () => {
    const { runId } = await seedRun('system');
    const close = await holdClose(runId);

    const admitted = insertAndEnqueueJob({
      projectId,
      issueId: null,
      pipelineRunId: runId,
      createdBy: ownerId,
      type: 'smoke',
      skillName: 'forge-smoke',
      promptString: 'admit me',
      payloadExtras: {},
    }).then(
      () => 'admitted',
      (err: unknown) => (err as { code?: string }).code ?? String(err),
    );
    try {
      await admissionWaitsOnTheRun();
    } finally {
      await close.commit();
    }

    expect(await admitted).toBe('RUN_CLOSED');
    expect(await liveJobsUnderTerminalRuns()).toBe(0);
  });

  it('a held successor is not written under the closed run', async () => {
    const { issueId, runId } = await seedRun('issue');
    const failedId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by)
      VALUES (${failedId}, ${projectId}, ${issueId}, ${runId}, 'drive', 'failed', ${ownerId})
    `);
    const { jobs } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const [failed] = await harness.db.select().from(jobs).where(eq(jobs.id, failedId));
    if (!failed) throw new Error('seeded job is missing');
    const close = await holdClose(runId);

    const held = holdJobForReason(failed, 'retry_rounds_exhausted');
    try {
      await admissionWaitsOnTheRun();
    } finally {
      await close.commit();
    }

    expect(await held).toBeNull();
    expect(await liveJobsUnderTerminalRuns()).toBe(0);
  });
});
