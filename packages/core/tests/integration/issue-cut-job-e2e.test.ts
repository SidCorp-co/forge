/**
 * ISS-1228 round 21 (judge-67, criteria 216, 217) — dropping an issue whose job a box was working ended
 * that job `done`, so its run and its drawer read "Completed" for work that was cut off. A job its
 * issue's end cuts short now ends cancelled, naming why; the job of the box whose own agent made the
 * move still ends done, as the step that closed its issue always has (ISS-352).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Vars = import('../../src/middleware/request-id.js').RequestIdVars;

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let deviceId: string;
let app: Hono<{ Variables: Vars }>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';

  const { pipelineRunReadRoutes } = await import('../../src/pipeline/runs-read-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: Vars }>();
  app.use('*', requestId());
  app.route('/api/pipeline-runs', pipelineRunReadRoutes as never);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  const { pairDevice } = await import('../helpers/pair-device.js');
  deviceId = (await pairDevice({ ownerId, name: 'box-a', platform: 'linux' })).device.id;
});

/** An issue in progress whose run's job a box is working, with its live session. */
async function workedIssue(): Promise<{ issueId: string; runId: string; jobId: string; sessionId: string }> {
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 3, 'Scratch cut-off target', 'in_progress', ${ownerId})
  `);
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
    VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running')
  `);
  const sessionId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status, started_at,
                                last_heartbeat_at)
    VALUES (${sessionId}, ${projectId}, ${runId}, ${deviceId}, 'pipeline', 'running', now(), now())
  `);
  const jobId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, issue_id, device_id, agent_session_id, created_by,
                      type, status, dispatched_at, acked_at, payload)
    VALUES (${jobId}, ${projectId}, ${runId}, ${issueId}, ${deviceId}, ${sessionId}, ${ownerId},
            'drive', 'running', now(), now(), '{}'::jsonb)
  `);
  return { issueId, runId, jobId, sessionId };
}

async function drop(issueId: string, actor: Parameters<typeof import('../../src/issues/apply-transition.js').transitionIssueStatus>[2]) {
  const { transitionIssueStatus } = await import('../../src/issues/apply-transition.js');
  await transitionIssueStatus(
    { id: issueId, projectId, status: 'in_progress', reopenCount: 0 },
    'dropped',
    actor,
    { transitionReason: 'Not wanted any more.' },
  );
}

async function rows(ids: { runId: string; jobId: string; sessionId: string }) {
  const [run] = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM pipeline_runs WHERE id = ${ids.runId}`,
  );
  const [job] = await harness.db.execute<{ status: string; failure_reason: string | null }>(
    sql`SELECT status, failure_reason FROM jobs WHERE id = ${ids.jobId}`,
  );
  const [session] = await harness.db.execute<{ status: string; failure_reason: string | null }>(
    sql`SELECT status, failure_reason FROM agent_sessions WHERE id = ${ids.sessionId}`,
  );
  return { run, job, session };
}

describe('a job its issue’s end cut off reads cut off (criteria 216, 217)', () => {
  it('ends the job a person’s drop cut short as cancelled for that, and stops its run', async () => {
    const worked = await workedIssue();
    await drop(worked.issueId, { type: 'user', id: ownerId, agency: 'human' });

    const { run, job, session } = await rows(worked);
    expect(job).toEqual({ status: 'cancelled', failure_reason: 'issue_dropped' });
    expect(session).toEqual({ status: 'cancelled', failure_reason: 'issue_dropped' });
    expect(run?.status).toBe('cancelled');

    const { signUserToken } = await import('../../src/auth/jwt.js');
    const res = await app.request(`/api/pipeline-runs/${worked.runId}`, {
      headers: { authorization: `Bearer ${await signUserToken(ownerId)}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      attempts: Array<{ status: string; failureReason: string | null }>;
    };
    expect(body.status).toBe('cancelled');
    expect(body.attempts[0]).toMatchObject({ status: 'cancelled', failureReason: 'issue_dropped' });
  });

  it('ends the job of the box whose own agent dropped its issue as done, as its own last act', async () => {
    const worked = await workedIssue();
    await drop(worked.issueId, { type: 'device', id: deviceId, ownerId });

    const { job, session } = await rows(worked);
    expect(job?.status).toBe('done');
    expect(session?.status).toBe('completed');
  });

  it('cuts a job on another box when an agent on this one drops the issue', async () => {
    const worked = await workedIssue();
    const { pairDevice } = await import('../helpers/pair-device.js');
    const other = (await pairDevice({ ownerId, name: 'box-b', platform: 'linux' })).device.id;
    await drop(worked.issueId, { type: 'device', id: other, ownerId });

    const { job } = await rows(worked);
    expect(job).toEqual({ status: 'cancelled', failure_reason: 'issue_dropped' });
  });
});
