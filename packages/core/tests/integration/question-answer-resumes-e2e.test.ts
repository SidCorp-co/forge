/**
 * ISS-996 — what resumes a park, once the park has asked a question.
 *
 * The comment lane and the answer lane both end in the same three hops, and the
 * claim here is about which one owns the resume. Real Postgres because both
 * decisions are joins, and what they must produce is a status and a job count.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ws/broadcast.js', () => ({
  broadcast: vi.fn(),
  broadcastToProject: vi.fn(),
}));

import {
  createTestDevice,
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let ownerId: string;
let projectId: string;
let deviceId: string;
let issueId: string;
let hooks: typeof import('../../src/pipeline/hooks.js').hooks;
let registerAnswerResume: typeof import('../../src/pipeline/answer-resume.js').registerAnswerResume;
let askParkQuestion: typeof import('../../src/questions/write.js').askParkQuestion;
let answerQuestion: typeof import('../../src/questions/write.js').answerQuestion;
let db: typeof import('../../src/db/client.js').db;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  ({ hooks } = await import('../../src/pipeline/hooks.js'));
  ({ registerAnswerResume } = await import('../../src/pipeline/answer-resume.js'));
  ({ askParkQuestion, answerQuestion } = await import('../../src/questions/write.js'));
  ({ db } = await import('../../src/db/client.js'));
  registerAnswerResume(hooks);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  deviceId = (await createTestDevice(harness.db, ownerId, { name: 'park-box' })).id;
  issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 1, 'parked', 'needs_info', ${ownerId})
  `);
});

async function aParkQuestion() {
  return askParkQuestion(db, {
    id: randomUUID(),
    projectId,
    issueId,
    prompt: 'the staging API rejects every write',
    needed: 'whether staging is read-only this week',
  });
}

async function statusOf(): Promise<string> {
  const rows = await harness.db.execute<{ status: string }>(sql`
    SELECT status FROM issues WHERE id = ${issueId}
  `);
  return (rows[0] as { status: string }).status;
}

async function comment(body: string) {
  const commentId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, body)
    VALUES (${commentId}, ${issueId}, ${ownerId}, ${body})
  `);
  await hooks.emit('commentCreated', {
    issueId,
    projectId,
    actor: { type: 'user', id: ownerId },
    authored: 'human',
    commentId,
    body,
  } as never);
}

describe('a park that asked a question', () => {
  it('is not resumed by a comment', async () => {
    await aParkQuestion();
    await comment('ok thanks');
    expect(await statusOf()).toBe('needs_info');
  });

  it('is resumed by answering the question', async () => {
    const q = await aParkQuestion();
    await answerQuestion({
      questionId: q.id,
      answer: { kind: 'text', text: 'yes, read-only until Friday' },
      round: 1,
      by: ownerId,
      role: 'member',
    });
    expect(await statusOf()).toBe('open');
  });

  it('mints an answerable question even when the park stated no need', async () => {
    const { mintParkQuestion, NEED_NOT_STATED } = await import('../../src/issues/park-question.js');
    await db.transaction(async (tx) => {
      await mintParkQuestion(
        {
          issue: { id: issueId, projectId },
          toStatus: 'needs_info',
          actor: { type: 'device', id: deviceId, ownerId },
          options: { transitionReason: 'blocked on something I cannot name' },
        },
        tx as never,
      );
    });
    const rows = await harness.db.execute<{ steps: Array<Record<string, unknown>> }>(sql`
      SELECT steps FROM agent_questions WHERE issue_id = ${issueId}
    `);
    const step = (rows[0] as { steps: Array<Record<string, unknown>> }).steps[0];
    expect(step?.needed).toBe(NEED_NOT_STATED);
  });

  it('is not resumed by a comment even when the park carries no question at all', async () => {
    await comment('here is the thing you asked for');
    expect(await statusOf()).toBe('needs_info');
  });

  it('dispatches nothing when a box is registered to read the answer back', async () => {
    const q = await aParkQuestion();
    await harness.db.execute(sql`
      INSERT INTO question_waiters (id, question_id, device_id, run_id)
      VALUES (${randomUUID()}, ${q.id}, ${deviceId}, 'run-1')
    `);
    await answerQuestion({
      questionId: q.id,
      answer: { kind: 'text', text: 'yes' },
      round: 1,
      by: ownerId,
      role: 'member',
    });
    expect(await statusOf()).toBe('needs_info');
  });
});
