/**
 * ISS-1133 r3 — a run's state follows its jobs when one is cancelled.
 *
 * A failed job closes its issue run and a one-shot run closes with its job, but a cancelled job
 * left its issue run `running` until the concluded-run reaper's quiet hour passed, so the run view
 * and the runs rollup read "Running" over a run with nothing left to run. The fixture is that
 * shape: an issue run whose only job is cancelled, read back through the two surfaces that show
 * it. Its control is a run holding a second live job, which a cancel must not close.
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
let seq = 900;

let cancelJob: typeof import('../../src/jobs/cancel-job.js').cancelJob;
let syncAgentSessionLifecycle: typeof import('../../src/jobs/agent-session-link.js').syncAgentSessionLifecycle;
let loadPipelineRunSummary: typeof import('../../src/pipeline/runs-rollup.js').loadPipelineRunSummary;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  ({ cancelJob } = await import('../../src/jobs/cancel-job.js'));
  ({ syncAgentSessionLifecycle } = await import('../../src/jobs/agent-session-link.js'));
  ({ loadPipelineRunSummary } = await import('../../src/pipeline/runs-rollup.js'));
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

async function seedIssueRun(): Promise<{ issueId: string; runId: string }> {
  const issueId = randomUUID();
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
    VALUES (${issueId}, ${projectId}, ${seq++}, 'a run whose job is cancelled', 'in_progress', 'medium', ${ownerId})
  `);
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
    VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running')
  `);
  return { issueId, runId };
}

async function seedJob(
  runId: string,
  issueId: string,
  status: string,
  type: 'drive' | 'smoke' = 'drive',
): Promise<string> {
  const jobId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by)
    VALUES (${jobId}, ${projectId}, ${issueId}, ${runId}, ${type}, ${status}, ${ownerId})
  `);
  return jobId;
}

async function runStatus(runId: string): Promise<string> {
  const rows = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM pipeline_runs WHERE id = ${runId}`,
  );
  return rows[0]?.status ?? 'missing';
}

async function journalStatus(issueId: string, runId: string): Promise<string | undefined> {
  const res = await fetch(
    `${server.baseUrl}/api/run-journal?projectId=${projectId}&issueId=${issueId}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { runs: { runId: string; status: string }[] };
  return body.runs.find((r) => r.runId === runId)?.status;
}

const CANCEL = {
  actorUserId: '',
  actorAgency: 'human' as const,
  reason: 'a person stopped it',
  source: 'rest' as const,
};

describe('a cancelled job and its run', () => {
  it('closes the issue run `cancelled` when its only job is cancelled, as the journal and the rollup read it', async () => {
    const { issueId, runId } = await seedIssueRun();
    const jobId = await seedJob(runId, issueId, 'queued');

    await cancelJob(jobId, { ...CANCEL, actorUserId: ownerId });

    expect(await runStatus(runId)).toBe('cancelled');
    expect(await journalStatus(issueId, runId)).toBe('cancelled');
    expect((await loadPipelineRunSummary(runId))?.status).toBe('cancelled');
  });

  it('leaves the run running while another of its jobs is still live', async () => {
    const { issueId, runId } = await seedIssueRun();
    const cancelled = await seedJob(runId, issueId, 'queued');
    await seedJob(runId, issueId, 'running', 'smoke');

    await cancelJob(cancelled, { ...CANCEL, actorUserId: ownerId });

    expect(await runStatus(runId)).toBe('running');
    expect(await journalStatus(issueId, runId)).toBe('running');
  });

  it('keeps the run open for a job whose admission commits while the close waits on the run', async () => {
    const { issueId, runId } = await seedIssueRun();
    const cancelled = await seedJob(runId, issueId, 'cancelled');
    const { jobs } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const [row] = await harness.db.select().from(jobs).where(eq(jobs.id, cancelled));
    if (!row) throw new Error('seeded job is missing');

    let admitted!: () => void;
    const admit = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admission = harness.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by)
        VALUES (${randomUUID()}, ${projectId}, ${issueId}, ${runId}, 'smoke', 'queued', ${ownerId})
      `);
      admitted();
      await held;
    });
    await admit;
    const closing = syncAgentSessionLifecycle(row, 'cancelled');
    await new Promise((r) => setTimeout(r, 300));
    release();
    await Promise.all([admission, closing]);

    expect(await runStatus(runId)).toBe('running');
    const live = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM jobs WHERE pipeline_run_id = ${runId} AND status = 'queued'`,
    );
    expect(live[0]?.n).toBe(1);
  });

  it('closes the run when a running job its runner stopped reports itself cancelled', async () => {
    const { issueId, runId } = await seedIssueRun();
    const sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, kind, status)
      VALUES (${sessionId}, ${projectId}, ${runId}, 'pipeline', 'running')
    `);
    const jobId = await seedJob(runId, issueId, 'cancelled');
    await harness.db.execute(
      sql`UPDATE jobs SET agent_session_id = ${sessionId} WHERE id = ${jobId}`,
    );
    const { jobs } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const [row] = await harness.db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!row) throw new Error('seeded job is missing');

    await syncAgentSessionLifecycle(row, 'cancelled');

    expect(await runStatus(runId)).toBe('cancelled');
  });

  it('leaves the run open when the cancel is a retry the run still owes', async () => {
    const { issueId, runId } = await seedIssueRun();
    const jobId = await seedJob(runId, issueId, 'cancelled');
    const { jobs } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const [row] = await harness.db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!row) throw new Error('seeded job is missing');

    await syncAgentSessionLifecycle(row, 'cancelled', { retryPending: true });

    expect(await runStatus(runId)).toBe('running');
  });
});
