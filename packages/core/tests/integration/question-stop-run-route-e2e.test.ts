/**
 * ISS-1228 round 20 (judge-62, 174/184) — a job that stops on a question reads so on the path the
 * judge walked: the runner's blocked report, the session row, `GET /api/pipeline-runs/:id`, and the
 * Questions tab naming the issue and the work that asked.
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
  deviceId = (await pairDevice({ ownerId, name: 'box-b', platform: 'linux' })).device.id;
});

async function newRun(): Promise<string> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'pm', 'running')
  `);
  return runId;
}

async function summary(runId: string) {
  const { loadPipelineRunSummary } = await import('../../src/pipeline/runs-rollup.js');
  const s = await loadPipelineRunSummary(runId);
  if (!s) throw new Error('no summary');
  return s;
}

describe('a job that stopped on a question reads so on the run route (criteria 174, 184, 189, 193)', () => {
  /** A newer job on another issue with a session of its own: the job a bare column bound to (rig, r20). */
  async function laterJobElsewhere(runId: string): Promise<void> {
    const otherIssue = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${otherIssue}, ${projectId}, 6, 'Split the billing job', 'in_progress', ${ownerId})
    `);
    const otherSession = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status, failure_reason, started_at)
      VALUES (${otherSession}, ${projectId}, ${runId}, ${deviceId}, 'pipeline', 'failed', 'provider_overloaded', now())
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, issue_id, device_id, agent_session_id, created_by,
                        type, status, queued_at, finished_at, payload)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${otherIssue}, ${deviceId}, ${otherSession}, ${ownerId},
              'review', 'failed', now() + interval '1 minute', now(), '{}'::jsonb)
    `);
  }

  it('carries the question stop through the session row to GET /api/pipeline-runs/:id', async () => {
    const runId = await newRun();
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueId}, ${projectId}, 5, 'Scratch migration target', 'in_progress', ${ownerId})
    `);
    const sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status, started_at,
                                  last_heartbeat_at, metadata)
      VALUES (${sessionId}, ${projectId}, ${runId}, ${deviceId}, 'pipeline', 'running', now(), now(),
              '{"jobType":"drive"}'::jsonb)
    `);
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, issue_id, device_id, agent_session_id, created_by,
                        type, status, dispatched_at, acked_at, payload)
      VALUES (${jobId}, ${projectId}, ${runId}, ${issueId}, ${deviceId}, ${sessionId}, ${ownerId},
              'drive', 'running', now(), now(), '{}'::jsonb)
    `);
    const { endBlockedJob } = await import('../../src/jobs/blocked.js');
    const ended = await endBlockedJob({ id: jobId, status: 'running' }, deviceId, {
      error: 'forge-runner: the pane has been stopped on a question only a human can answer for 2m',
      asked: {
        kind: 'dialog',
        questions: [
          {
            question: 'Which database should the scratch migration target?',
            options: [{ label: 'Primary' }, { label: 'Replica' }],
          },
        ],
      },
    });
    expect(ended.questionIds).toHaveLength(1);

    const [session] = await harness.db.execute<{ failure_reason: string | null }>(
      sql`SELECT failure_reason FROM agent_sessions WHERE id = ${sessionId}`,
    );
    expect(session?.failure_reason).toBe('stopped_on_question');

    const { signUserToken } = await import('../../src/auth/jwt.js');
    const res = await app.request(`/api/pipeline-runs/${runId}`, {
      headers: { authorization: `Bearer ${await signUserToken(ownerId)}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projectSlug: string;
      startedAt: string;
      steps: Array<{ startedAt: string | null; finishedAt: string | null }>;
      attempts: Array<{ failureCause: string | null; failureReason: string | null }>;
    };
    expect(body.attempts[0]?.failureReason).toBe('stopped_on_question');
    expect(body.attempts[0]?.failureCause).toBe('stopped_on_question');

    // Every time the route answers is ISO, the step times a raw aggregate reads included.
    const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
    expect(body.startedAt).toMatch(ISO);
    expect(body.steps.length).toBeGreaterThan(0);
    for (const step of body.steps) {
      expect(step.startedAt).toMatch(ISO);
      expect(step.finishedAt).toMatch(ISO);
    }

    // The drawer links the run's issue from its own project, whatever org the reader has active.
    const [project] = await harness.db.execute<{ slug: string }>(
      sql`SELECT slug FROM projects WHERE id = ${projectId}`,
    );
    expect(body.projectSlug).toBe(project?.slug);

    // Its question stays the project's, read on the Questions tab, naming the issue and the work —
    // its own job's, though a newer job elsewhere has a session too.
    await laterJobElsewhere(runId);
    const { projectQuestionsFor } = await import('../../src/questions/read.js');
    const page = await projectQuestionsFor(projectId, ownerId, 'open', { limit: 10 }, true);
    expect(page?.questions[0]?.issueId).toBeNull();
    expect(page?.questions[0]?.askedBy).toEqual({
      jobType: 'drive',
      issueId,
      issueRef: 'ISS-5',
      issueTitle: 'Scratch migration target',
    });
  });

  it('reads a question stop recorded before round 20 as one, though its session row says unclassified', async () => {
    const runId = await newRun();
    const sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status, failure_reason, started_at)
      VALUES (${sessionId}, ${projectId}, ${runId}, ${deviceId}, 'pipeline', 'failed', 'unclassified', now())
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, device_id, agent_session_id, created_by, type, status,
                        failure_reason, error, payload, finished_at)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${deviceId}, ${sessionId}, ${ownerId}, 'drive', 'failed',
              'stopped_on_question', 'pane stopped on a question', '{}'::jsonb, now())
    `);
    expect((await summary(runId)).attempts[0]?.failureCause).toBe('stopped_on_question');
  });

  it('names no job for a question a master asked through the device door', async () => {
    await laterJobElsewhere(await newRun());
    const { askQuestion } = await import('../../src/questions/write.js');
    await askQuestion({
      id: randomUUID(),
      projectId,
      prompt: 'Which box takes the next wave?',
      blockerKind: 'human',
      answer: { shape: 'free_text', needed: 'a box name' },
    });
    const { projectQuestionsFor } = await import('../../src/questions/read.js');
    const page = await projectQuestionsFor(projectId, ownerId, 'open', { limit: 10 }, true);
    expect(page?.questions[0]?.askedBy).toBeNull();
  });
});
