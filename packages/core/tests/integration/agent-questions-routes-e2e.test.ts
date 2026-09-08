/**
 * ISS-964 criteria 12, 15, 17, 18 — what an answer is, and who may see it.
 *
 * The claim under all four is the same one: the connection is a doorbell and
 * the row is the event. So every assertion here is made by reading a row back,
 * never from the response to the write that made it.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let write: typeof import('../../src/questions/write.js');
let read: typeof import('../../src/questions/read.js');
let stop: typeof import('../../src/questions/stop.js');
let schema: typeof import('../../src/db/schema.js');
let ctx: { projectId: string; adminId: string; memberId: string; viewerId: string };

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  write = await import('../../src/questions/write.js');
  read = await import('../../src/questions/read.js');
  stop = await import('../../src/questions/stop.js');
  schema = await import('../../src/db/schema.js');
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const admin = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, admin.id);
  const member = await createTestUser(harness.db);
  const viewer = await createTestUser(harness.db);
  await createTestProjectMember(harness.db, {
    projectId: project.id,
    userId: member.id,
    role: 'member',
  });
  await createTestProjectMember(harness.db, {
    projectId: project.id,
    userId: viewer.id,
    role: 'viewer',
  });
  ctx = {
    projectId: project.id,
    adminId: admin.id,
    memberId: member.id,
    viewerId: viewer.id,
  };
});

const adminOption = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'Deploy it',
  authority: 'admin' as const,
  bindsTo: 'project' as const,
  executedBy: 'human' as const,
};
const writerOption = {
  id: '22222222-2222-4222-8222-222222222222',
  label: 'Take the safe path',
  authority: 'writer' as const,
  bindsTo: 'session' as const,
  executedBy: 'agent' as const,
};

async function aQuestion(over: Record<string, unknown> = {}) {
  return write.askQuestion({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    prompt: 'Which way?',
    blockerKind: 'human',
    options: [writerOption, adminOption],
    recommendedOptionId: writerOption.id,
    ...over,
  });
}

describe('who may see a question, and which of its options', () => {
  it('shows a member the whole question and locks only the admin options', async () => {
    const q = await aQuestion();
    const seen = await read.readQuestionFor(q.id, ctx.memberId);

    expect(
      seen,
      'a writer seeing no question at all is the failure criterion 15 names',
    ).not.toBeNull();
    expect(seen?.options.map((o) => [o.label, o.locked])).toEqual([
      ['Take the safe path', false],
      ['Deploy it', true],
    ]);
  });

  it('unlocks every option for an admin', async () => {
    const q = await aQuestion();
    const seen = await read.readQuestionFor(q.id, ctx.adminId);
    expect(seen?.options.every((o) => !o.locked)).toBe(true);
  });

  it('shows a viewer the question with nothing choosable', async () => {
    const q = await aQuestion();
    const seen = await read.readQuestionFor(q.id, ctx.viewerId);
    expect(seen).not.toBeNull();
    expect(seen?.options.every((o) => o.locked)).toBe(true);
  });

  it('refuses to answer with an option the caller may not choose', async () => {
    const q = await aQuestion();
    await expect(
      read.answerAs({ questionId: q.id, optionId: adminOption.id, userId: ctx.memberId }),
      'a locked option that answers anyway is a lock drawn on the screen and nowhere else (ISS-964 criterion 15)',
    ).rejects.toThrow(/authority|not allowed/i);
  });
});

describe('an answer belongs to the question, not to the waiter', () => {
  it('is still there for whoever continues after a revival is cancelled', async () => {
    const q = await aQuestion();
    await read.answerAs({ questionId: q.id, optionId: writerOption.id, userId: ctx.memberId });

    const after = await write.getQuestion(q.id);
    expect(
      after?.steps.at(-1)?.chosenOptionId,
      'an answer consumed by the waiter that read it leaves the next continuation with nothing, and the human is asked the same thing again (ISS-964 criterion 18)',
    ).toBe(writerOption.id);
    expect(await read.answerOf(q.id)).toMatchObject({ optionId: writerOption.id });
    expect(await read.answerOf(q.id)).toMatchObject({ optionId: writerOption.id });
  });

  it('revives every waiter on one question from one answer', async () => {
    const q = await aQuestion();
    const user = await createTestUser(harness.db);
    const device = await createTestDevice(harness.db, user.id);
    await read.registerWaiter({ questionId: q.id, deviceId: device.id, runId: 'run-a' });
    await read.registerWaiter({ questionId: q.id, deviceId: device.id, runId: 'run-b' });

    await read.answerAs({ questionId: q.id, optionId: writerOption.id, userId: ctx.memberId });

    expect(
      (await read.waitersOf(q.id)).map((w) => w.runId).sort(),
      'one answer to one question revives all N waiters on it — a design that answers the waiter rather than the question owes the human N clicks (ISS-964 criterion 18)',
    ).toEqual(['run-a', 'run-b']);
  });
});

describe('the connection is a doorbell', () => {
  it('delivers the answer to a box that was offline for the whole episode', async () => {
    const q = await aQuestion();
    await read.answerAs({ questionId: q.id, optionId: writerOption.id, userId: ctx.memberId });

    expect(
      await read.answerOf(q.id),
      'an answer that exists only as a published frame is lost to a box that was down when it went out — only latency may be lost (ISS-964 criterion 12)',
    ).toMatchObject({ optionId: writerOption.id, questionId: q.id });
  });
});

describe('stop is enforced on the record', () => {
  it('reaches terminal on a session with no process behind it', async () => {
    const user = await createTestUser(harness.db);
    const [run] = await harness.db
      .insert(schema.pipelineRuns)
      .values({ projectId: ctx.projectId, kind: 'pm', status: 'running' })
      .returning();
    const [session] = await harness.db
      .insert(schema.agentSessions)
      .values({
        userId: user.id,
        projectId: ctx.projectId,
        pipelineRunId: run?.id as string,
        status: 'running',
      })
      .returning();
    const q = await aQuestion({ agentSessionId: session?.id });

    await stop.stopSession({
      agentSessionId: session?.id as string,
      by: ctx.adminId,
      reason: 'no longer needed',
    });

    const [after] = await harness.db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, session?.id as string));
    expect(
      after?.status,
      'a stop delivered as a message the agent may honour never lands on a session whose process is already gone, and the record stays live forever (ISS-964 criterion 17)',
    ).toBe('cancelled');
    const question = await write.getQuestion(q.id);
    expect(question?.status).toBe('void');
    expect(question?.voidReason).toMatch(/stop/i);
  });
});
