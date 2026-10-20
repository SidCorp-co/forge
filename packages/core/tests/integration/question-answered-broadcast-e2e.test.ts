/**
 * ISS-1228 round 22 (judge-71, criterion 227) — an open issue page kept "Needs an answer" and its
 * Answer button for a minute or more after the question was answered, because nothing told a
 * browser an answer had come. Answering through the person's own door now tells the project's
 * room which issue's question was answered, and only that.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let ownerId: string;
let projectId: string;
let deviceId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ app } = (await import('../../src/index.js')) as unknown as { app: Hono<AppVars> });
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

/** A job working an issue that stopped on a question, as a box reports it. */
async function askedOnIssue(): Promise<{ issueId: string; questionId: string; optionId: string }> {
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 5, 'Scratch answered target', 'in_progress', ${ownerId})
  `);
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
    VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running')
  `);
  const jobId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, issue_id, device_id, created_by,
                      type, status, dispatched_at, acked_at, payload)
    VALUES (${jobId}, ${projectId}, ${runId}, ${issueId}, ${deviceId}, ${ownerId},
            'drive', 'running', now(), now(), '{}'::jsonb)
  `);
  const { endBlockedJob } = await import('../../src/jobs/blocked.js');
  const ended = await endBlockedJob({ id: jobId, status: 'running' }, deviceId, {
    error: 'forge-runner: the pane has been stopped on a question only a human can answer for 2m',
    asked: {
      kind: 'dialog',
      questions: [
        { question: 'Which database?', options: [{ label: 'Primary' }, { label: 'Replica' }] },
      ],
    },
  });
  const questionId = ended.questionIds[0];
  if (!questionId) throw new Error('the job must have asked');
  const [row] = await harness.db.execute<{ steps: Array<{ options?: Array<{ id: string }> }> }>(
    sql`SELECT steps FROM agent_questions WHERE id = ${questionId}`,
  );
  const optionId = row?.steps.at(-1)?.options?.[0]?.id;
  if (!optionId) throw new Error('the question must offer a choice');
  return { issueId, questionId, optionId };
}

describe('an answer reaches every open page of its issue (criterion 227)', () => {
  it('tells the project room which issue’s question a person answered', async () => {
    const asked = await askedOnIssue();
    const { roomManager } = await import('../../src/ws/server.js');
    const { projectRoom } = await import('../../src/ws/rooms.js');
    const publish = vi.spyOn(roomManager, 'publish');
    try {
      const { signUserToken } = await import('../../src/auth/jwt.js');
      const res = await app.request(`/api/questions/${asked.questionId}/answer`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await signUserToken(ownerId)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ optionId: asked.optionId, round: 1 }),
      });
      expect(res.status).toBe(200);

      const frames = publish.mock.calls.filter(
        ([room, frame]) =>
          room === projectRoom(projectId) &&
          (frame as { event: string }).event === 'question.answered',
      );
      expect(frames.map(([, frame]) => frame)).toEqual([
        {
          event: 'question.answered',
          data: { questionId: asked.questionId, projectId, issueId: asked.issueId },
        },
      ]);
    } finally {
      publish.mockRestore();
    }
  });
});
