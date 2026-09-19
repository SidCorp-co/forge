/**
 * ISS-980 — the answer write is one atomic write, and the screen that reaches it.
 *
 * Every refusal here is judged by reading the ROW back: `status`, `steps` and
 * `updated_at` before and after. A refusal that still moved one of the three is
 * the defect this issue owns, and no mocked transaction can see it — the unit
 * lane in `src/questions/answer-wakes-the-box.test.ts` proves the call shape,
 * this proves the durable one.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chosenOptionIdOf } from '../../src/db/schema-questions.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const JWT_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';

let harness: TestDatabase;
let write: typeof import('../../src/questions/write.js');
let read: typeof import('../../src/questions/read.js');
let schema: typeof import('../../src/db/schema-questions.js');
let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;

let projectId: string;
let adminId: string;
let memberId: string;
let strangerId: string;
let issueId: string;
let seq = 0;

const WRITER = {
  id: '22222222-2222-4222-8222-222222222222',
  label: 'Take the safe path',
  authority: 'writer' as const,
  bindsTo: 'session' as const,
  executedBy: 'agent' as const,
};
const ADMIN = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'Deploy it',
  authority: 'admin' as const,
  bindsTo: 'project' as const,
  executedBy: 'human' as const,
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  write = await import('../../src/questions/write.js');
  read = await import('../../src/questions/read.js');
  schema = await import('../../src/db/schema-questions.js');

  const { questionRoutes } = await import('../../src/questions/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/questions', questionRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const admin = await createTestUser(harness.db);
  const member = await createTestUser(harness.db);
  const stranger = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  const project = await createTestProject(harness.db, admin.id);
  await createTestProjectMember(harness.db, {
    projectId: project.id,
    userId: member.id,
    role: 'member',
  });
  adminId = admin.id;
  memberId = member.id;
  strangerId = stranger.id;
  projectId = project.id;
  issueId = await anIssue();
});

async function anIssue(): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'needs_info', ${adminId})
  `);
  return id;
}

async function aQuestion(over: Record<string, unknown> = {}) {
  return write.askQuestion({
    id: randomUUID(),
    projectId,
    issueId,
    prompt: 'Which way?',
    blockerKind: 'human',
    answer: { shape: 'choice', options: [WRITER, ADMIN], recommendedOptionId: WRITER.id },
    ...over,
  });
}

async function rowOf(questionId: string) {
  const [row] = await harness.db
    .select()
    .from(schema.agentQuestions)
    .where(eq(schema.agentQuestions.id, questionId));
  return row;
}

/** The three columns a refusal may not move, as one comparable value. */
function snapshot(row: Awaited<ReturnType<typeof rowOf>>) {
  return JSON.stringify({
    status: row?.status,
    steps: row?.steps,
    updatedAt: row?.updatedAt?.toISOString(),
  });
}

async function token(userId: string) {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  return `Bearer ${await signUserToken(userId)}`;
}

const answer = (args: {
  questionId: string;
  optionId?: string;
  round?: number;
  by?: string;
  role?: 'admin' | 'member' | 'viewer' | null;
}) =>
  write.answerQuestion({
    questionId: args.questionId,
    answer: { kind: 'option', optionId: args.optionId ?? WRITER.id },
    round: args.round ?? 1,
    by: args.by ?? memberId,
    role: args.role === undefined ? 'member' : args.role,
  });

describe('one winner, and the row is untouched by every loser', () => {
  it('records the answer on the round it was given', async () => {
    const q = await aQuestion();
    await answer({ questionId: q.id });

    const row = await rowOf(q.id);
    expect(row?.status).toBe('answered');
    expect(chosenOptionIdOf(row?.steps.at(-1))).toBe(WRITER.id);
    expect(row?.steps.at(-1)?.answeredBy).toBe(memberId);
  });

  it('refuses a second answer and leaves the first one standing', async () => {
    const q = await aQuestion();
    await answer({ questionId: q.id, by: memberId });
    const before = snapshot(await rowOf(q.id));

    await expect(answer({ questionId: q.id, by: adminId, role: 'admin' })).rejects.toThrow(
      /is answered/,
    );

    const after = await rowOf(q.id);
    expect(after?.steps.at(-1)?.answeredBy).toBe(memberId);
    expect(snapshot(after)).toBe(before);
  });

  it('refuses an answer to a voided question rather than resurrecting the row', async () => {
    const q = await aQuestion();
    await write.voidQuestion({ questionId: q.id, reason: 'the branch is gone' });
    const before = snapshot(await rowOf(q.id));

    await expect(answer({ questionId: q.id })).rejects.toThrow(/is void/);

    const after = await rowOf(q.id);
    expect(after?.status).toBe('void');
    expect(after?.voidReason).toBe('the branch is gone');
    expect(snapshot(after)).toBe(before);
  });

  it('refuses an answer to an expired question', async () => {
    const q = await aQuestion();
    await harness.db
      .update(schema.agentQuestions)
      .set({ status: 'expired', endedReason: 'unanswered_2d' })
      .where(eq(schema.agentQuestions.id, q.id));
    const before = snapshot(await rowOf(q.id));

    await expect(answer({ questionId: q.id })).rejects.toThrow(/is expired/);
    expect(snapshot(await rowOf(q.id))).toBe(before);
  });

  it('refuses an answer bound to a round that has been superseded', async () => {
    const q = await aQuestion();
    await answer({ questionId: q.id });
    await write.askFollowUp({
      questionId: q.id,
      prompt: 'And the tag?',
      answer: { shape: 'choice', options: [WRITER], recommendedOptionId: WRITER.id },
    });
    const before = snapshot(await rowOf(q.id));

    await expect(answer({ questionId: q.id, round: 1 })).rejects.toThrow(
      /round 1 and the question is on round 2/,
    );
    expect(snapshot(await rowOf(q.id))).toBe(before);
  });

  it('refuses an option that is not on the current round', async () => {
    const q = await aQuestion();
    const before = snapshot(await rowOf(q.id));

    await expect(
      answer({ questionId: q.id, optionId: '33333333-3333-4333-8333-333333333333' }),
    ).rejects.toThrow(/33333333-3333-4333-8333-333333333333 is not on round 1/);
    expect(snapshot(await rowOf(q.id))).toBe(before);
  });

  it('refuses an option whose authority the caller may not choose', async () => {
    const q = await aQuestion();
    const before = snapshot(await rowOf(q.id));

    await expect(answer({ questionId: q.id, optionId: ADMIN.id })).rejects.toThrow(
      /authority admin/,
    );
    expect(snapshot(await rowOf(q.id))).toBe(before);
  });

  it('refuses an answer whose park deadline has already passed', async () => {
    const q = await aQuestion({ parkDeadlineAt: new Date(Date.now() - 60_000) });
    const before = snapshot(await rowOf(q.id));

    await expect(answer({ questionId: q.id })).rejects.toThrow(/park deadline passed/);
    expect(snapshot(await rowOf(q.id))).toBe(before);
  });

  it('refuses an answer whose wait for the row lock outlasted the deadline', async () => {
    const q = await aQuestion({ parkDeadlineAt: new Date(Date.now() + 700) });

    let release: () => void = () => {};
    let holding: () => void = () => {};
    const held = new Promise<void>((res) => {
      release = res;
    });
    const lockHeld = new Promise<void>((res) => {
      holding = res;
    });
    const holder = harness.db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.agentQuestions)
        .where(eq(schema.agentQuestions.id, q.id))
        .for('update');
      holding();
      await held;
    });
    await lockHeld;

    const queued = answer({ questionId: q.id }).then(
      () => null,
      (e: Error) => e,
    );
    await new Promise((res) => setTimeout(res, 1200));
    release();
    await holder;

    const outcome = await queued;
    expect(
      outcome?.message,
      'a deadline sampled before the wait lets through exactly the answer that arrived after it',
    ).toMatch(/park deadline passed/);
    expect((await rowOf(q.id))?.status).toBe('open');
  });

  it('lets exactly one of two concurrent answers through, and keeps that one', async () => {
    const q = await aQuestion();
    const attempts = [
      { by: memberId, role: 'member' as const, optionId: WRITER.id },
      { by: adminId, role: 'admin' as const, optionId: ADMIN.id },
    ];

    const settled = await Promise.allSettled(
      attempts.map((a) => answer({ questionId: q.id, ...a })),
    );

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(1);

    const winner = attempts[settled.findIndex((s) => s.status === 'fulfilled')];
    const row = await rowOf(q.id);
    const answered = row?.steps.filter((s) => chosenOptionIdOf(s)) ?? [];
    expect(answered).toHaveLength(1);
    expect(chosenOptionIdOf(answered[0])).toBe(winner?.optionId);
    expect(answered[0]?.answeredBy).toBe(winner?.by);
    expect(row?.status).toBe('answered');
  });
});

describe('who may read a question, and who may only look', () => {
  it('shows a signed-in stranger nothing at all', async () => {
    const q = await aQuestion();
    expect(await read.readQuestionFor(q.id, strangerId)).toBeNull();
    expect(await read.readQuestionsForIssue(issueId, strangerId)).toBeNull();
  });

  it('refuses a stranger the answer as well as the read', async () => {
    const q = await aQuestion();
    await expect(
      read.answerAs({
        questionId: q.id,
        answer: { kind: 'option', optionId: WRITER.id },
        round: 1,
        userId: strangerId,
      }),
    ).rejects.toThrow(/no question/);
    expect((await rowOf(q.id))?.status).toBe('open');
  });

  it('locks the writer option for a caller with no role rather than merely not showing it', async () => {
    const q = await aQuestion();
    await expect(answer({ questionId: q.id, role: null })).rejects.toThrow(/authority writer/);
  });

  it('lists an issue with no question as an empty list, not as a refusal', async () => {
    const bare = await anIssue();
    expect(await read.readQuestionsForIssue(bare, memberId)).toEqual([]);
  });

  it('hides a question row naming a different project than its issue', async () => {
    const q = await aQuestion();
    const elsewhere = await createTestProject(harness.db, adminId);
    const crossed = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
      VALUES (${crossed}, ${elsewhere.id}, ${issueId}, 'open', 'human',
              ${JSON.stringify([
                {
                  round: 1,
                  prompt: 'the other project decision',
                  answerShape: 'choice',
                  options: [WRITER],
                  recommendedOptionId: WRITER.id,
                  askedAt: new Date().toISOString(),
                },
              ])}::jsonb)
    `);

    const seen = await read.readQuestionsForIssue(issueId, memberId);
    expect(seen?.map((x) => x.id)).toEqual([q.id]);
    expect(JSON.stringify(seen)).not.toContain('the other project decision');
  });

  it('still lists a question whose project matches its issue', async () => {
    const q = await aQuestion();
    expect((await read.readQuestionsForIssue(issueId, memberId))?.map((x) => x.id)).toEqual([q.id]);
  });

  it('carries the whole round history to a member', async () => {
    const q = await aQuestion();
    await answer({ questionId: q.id });
    await write.askFollowUp({
      questionId: q.id,
      prompt: 'And the tag?',
      answer: { shape: 'choice', options: [WRITER], recommendedOptionId: WRITER.id },
    });

    const seen = await read.readQuestionsForIssue(issueId, memberId);
    expect(seen).toHaveLength(1);
    expect(seen?.[0]?.steps.map((s) => s.round)).toEqual([1, 2]);
    expect(seen?.[0]?.options.map((o) => [o.id, o.locked])).toEqual([[WRITER.id, false]]);
  });
});

describe('the routes a browser reaches this by', () => {
  it('answers the issue-scoped list to a member', async () => {
    const q = await aQuestion();
    const res = await app.request(`/api/questions?issueId=${issueId}`, {
      headers: { authorization: await token(memberId) },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { questions: Array<{ id: string }> };
    expect(body.questions.map((x) => x.id)).toEqual([q.id]);
  });

  it('answers 404 to a signed-in stranger', async () => {
    await aQuestion();
    const res = await app.request(`/api/questions?issueId=${issueId}`, {
      headers: { authorization: await token(strangerId) },
    });
    expect(res.status).toBe(404);
  });

  it('answers 400 to a malformed issue id rather than raising a 500', async () => {
    const res = await app.request('/api/questions?issueId=not-a-uuid', {
      headers: { authorization: await token(memberId) },
    });
    expect(res.status).toBe(400);
  });

  it('answers 400 to an answer that names no round', async () => {
    const q = await aQuestion();
    const res = await app.request(`/api/questions/${q.id}/answer`, {
      method: 'POST',
      headers: { authorization: await token(memberId), 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: WRITER.id }),
    });

    expect(res.status).toBe(400);
    expect((await rowOf(q.id))?.status).toBe('open');
  });

  it('refuses a stale round as a coded conflict the browser can read', async () => {
    const q = await aQuestion();
    await answer({ questionId: q.id });
    await write.askFollowUp({
      questionId: q.id,
      prompt: 'And the tag?',
      answer: { shape: 'choice', options: [WRITER], recommendedOptionId: WRITER.id },
    });

    const res = await app.request(`/api/questions/${q.id}/answer`, {
      method: 'POST',
      headers: { authorization: await token(memberId), 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: WRITER.id, round: 1 }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe('QUESTION_ROUND_STALE');
    expect(body.message).toMatch(/round 1 and the question is on round 2/);
  });

  it('refuses a locked option as a coded 403 naming the authority', async () => {
    const q = await aQuestion();
    const res = await app.request(`/api/questions/${q.id}/answer`, {
      method: 'POST',
      headers: { authorization: await token(memberId), 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: ADMIN.id, round: 1 }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe('QUESTION_AUTHORITY_REQUIRED');
    expect(body.message).toMatch(/authority admin/);
  });

  it('takes an answer from an admin on an admin-authority option', async () => {
    const q = await aQuestion();
    const res = await app.request(`/api/questions/${q.id}/answer`, {
      method: 'POST',
      headers: { authorization: await token(adminId), 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: ADMIN.id, round: 1 }),
    });

    expect(res.status).toBe(200);
    expect(chosenOptionIdOf((await rowOf(q.id))?.steps.at(-1))).toBe(ADMIN.id);
  });
});
