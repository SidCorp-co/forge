/**
 * ISS-1228 round 21 (judge-67, criterion 207) — once a job's question was answered, the drawer still
 * read "Answer its question on its issue's page." under the header "Answered". The run route now says
 * who answered and when, off the answered step, so the drawer has something true to say instead.
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
  await harness.db.execute(sql`UPDATE users SET display_name = 'Ann Lee' WHERE id = ${ownerId}`);
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  const { pairDevice } = await import('../helpers/pair-device.js');
  deviceId = (await pairDevice({ ownerId, name: 'box-a', platform: 'linux' })).device.id;
});

type Attempt = { questionOn: string | null; questionAnswered: { userId: string | null; name: string | null; at: string } | null };

async function attemptsOf(runId: string): Promise<Attempt[]> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const res = await app.request(`/api/pipeline-runs/${runId}`, {
    headers: { authorization: `Bearer ${await signUserToken(ownerId)}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { attempts: Attempt[] }).attempts;
}

describe('an answered question names who answered it (criterion 207)', () => {
  it('reads unanswered, then answered by its person at the time they answered', async () => {
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueId}, ${projectId}, 4, 'Scratch question target', 'in_progress', ${ownerId})
    `);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running')
    `);
    const sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status, started_at, last_heartbeat_at)
      VALUES (${sessionId}, ${projectId}, ${runId}, ${deviceId}, 'pipeline', 'running', now(), now())
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
        questions: [{ question: 'Which database?', options: [{ label: 'Primary' }, { label: 'Replica' }] }],
      },
    });
    const questionId = ended.questionIds[0];
    if (!questionId) throw new Error('the job must have asked');

    expect((await attemptsOf(runId))[0]).toMatchObject({ questionOn: 'issue', questionAnswered: null });

    const [row] = await harness.db.execute<{ steps: Array<{ round: number; options?: Array<{ id: string }> }> }>(
      sql`SELECT steps FROM agent_questions WHERE id = ${questionId}`,
    );
    const step = row?.steps.at(-1);
    const optionId = step?.options?.[0]?.id;
    if (!step || !optionId) throw new Error('the question must offer a choice');
    const { answerQuestion } = await import('../../src/questions/write.js');
    const before = Date.now();
    await answerQuestion({
      questionId,
      answer: { kind: 'option', optionId },
      round: step.round,
      by: ownerId,
      role: 'admin',
    });

    const answered = (await attemptsOf(runId))[0]?.questionAnswered;
    expect(answered).toMatchObject({ userId: ownerId, name: 'Ann Lee' });
    expect(Date.parse(answered?.at ?? '')).toBeGreaterThanOrEqual(before - 1000);
  });
});
