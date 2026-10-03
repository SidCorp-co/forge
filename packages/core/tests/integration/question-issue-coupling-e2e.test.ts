/**
 * ISS-1257 — an agent question and the issue it stops are one state. Real Postgres: every
 * claim is about what `issues` and `agent_questions` hold after one transaction.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ws/broadcast.js', () => ({
  broadcast: vi.fn(),
  broadcastToProject: vi.fn(),
}));

import { makeFakeJobPrincipal, makeFakePrincipal } from '../../src/mcp/fake-principal.fixture.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedProjectSource,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type IssueRow = import('../../src/issues/apply-transition.js').TransitionIssueRow;

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let seq = 0;

let transition: typeof import('../../src/issues/apply-transition.js');
let write: typeof import('../../src/questions/write.js');
let tools: typeof import('../../src/mcp/tools/forge-questions.js');
let attention: typeof import('../../src/me/attention-buckets.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  transition = await import('../../src/issues/apply-transition.js');
  write = await import('../../src/questions/write.js');
  attention = await import('../../src/me/attention-buckets.js');
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  await seedProjectSource(harness.db, projectId, owner.id, 'git');
});

async function insertIssue(status: string, merged = true): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, waiting_kind, created_by_id,
                        assignee_id, merged_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status},
            ${status === 'needs_info' ? 'needs_answer' : null}, ${ownerId}, ${ownerId},
            ${merged ? sql`now()` : null})
  `);
  return id;
}

async function load(id: string): Promise<IssueRow> {
  const rows = await harness.db.execute(sql`
    SELECT id, project_id AS "projectId", status, reopen_count AS "reopenCount"
    FROM issues WHERE id = ${id}
  `);
  return rows[0] as unknown as IssueRow;
}

async function statusOf(id: string): Promise<string> {
  return (await load(id)).status;
}

async function questionsOn(issueId: string) {
  const rows = await harness.db.execute(sql`
    SELECT id, status, void_reason AS "voidReason", ended_by AS "endedBy",
           ended_reason AS "endedReason", steps
    FROM agent_questions WHERE issue_id = ${issueId} ORDER BY created_at
  `);
  return rows as unknown as Array<{
    id: string;
    status: string;
    voidReason: string | null;
    endedBy: string | null;
    endedReason: string | null;
    steps: Array<Record<string, unknown>>;
  }>;
}

const round = { round: 1, prompt: 'Which tenant?', askedAt: '2026-09-27T10:00:00Z' };
const ASKED = { ...round, answerShape: 'free_text', needed: 'the tenant slug' };
const ANSWERED = { ...ASKED, answeredAt: '2026-09-27T11:00:00Z', answerText: 'acme' };

async function question(issueId: string, status: string, blockerKind: string, step: object) {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
    VALUES (${id}, ${projectId}, ${issueId}, ${status}, ${blockerKind}, ${JSON.stringify([step])}::jsonb)
  `);
  return id;
}

const openQuestion = (issueId: string, blockerKind = 'human') =>
  question(issueId, 'open', blockerKind, ASKED);
const answeredQuestion = (issueId: string) => question(issueId, 'answered', 'human', ANSWERED);

const person = () => ({ type: 'user' as const, id: ownerId, agency: 'human' as const });
// A move to `dropped` says why on its own (VOID_REASON_REQUIRED), so the question check is reached.
const DROP_REASON = { transitionReason: 'a duplicate of the tenant issue' };

async function refusalOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as InstanceType<typeof transition.TransitionError>;
  }
  throw new Error('the call was expected to be refused and it went through');
}

describe('an issue cannot reach a terminal status while it holds an open question', () => {
  for (const terminal of ['closed', 'dropped'] as const) {
    it(`refuses ${terminal} by name, with the count and the ids, and moves nothing`, async () => {
      const issueId = await insertIssue('in_progress');
      const a = await openQuestion(issueId);
      const b = await openQuestion(issueId, 'master_or_peer');

      const err = await refusalOf(
        transition.transitionIssueStatus(
          await load(issueId),
          terminal,
          person(),
          terminal === 'dropped' ? DROP_REASON : {},
        ),
      );

      expect(err).toBeInstanceOf(transition.TransitionError);
      expect(err.code).toBe('OPEN_QUESTIONS');
      expect(err.detail).toContain('2 open questions');
      expect(err.detail).toContain(a);
      expect(err.detail).toContain(b);
      expect(err.detail).toMatch(/voidQuestions/);
      expect(err.details).toMatchObject({ openQuestionIds: expect.arrayContaining([a, b]) });
      expect(await statusOf(issueId)).toBe('in_progress');
      expect((await questionsOn(issueId)).map((q) => q.status)).toEqual(['open', 'open']);
    });
  }

  it('closes with voidQuestions and leaves every open question void with that reason', async () => {
    const issueId = await insertIssue('in_progress');
    await openQuestion(issueId);
    await openQuestion(issueId);
    const kept = await answeredQuestion(issueId);

    await transition.transitionIssueStatus(await load(issueId), 'closed', person(), {
      voidQuestions: 'the fix shipped without the tenant answer',
    });

    expect(await statusOf(issueId)).toBe('closed');
    const rows = await questionsOn(issueId);
    const voided = rows.filter((q) => q.id !== kept);
    expect(voided).toHaveLength(2);
    for (const q of voided) {
      expect(q.status).toBe('void');
      expect(q.voidReason).toContain('the fix shipped without the tenant answer');
      expect(q.endedReason).toBe('issue_terminal');
      expect(q.endedBy).toBe(ownerId);
    }
    expect(rows.find((q) => q.id === kept)?.status).toBe('answered');
  });

  it('drops with voidQuestions under the same contract as a close', async () => {
    const issueId = await insertIssue('in_progress', false);
    await openQuestion(issueId);

    await transition.transitionIssueStatus(await load(issueId), 'dropped', person(), {
      ...DROP_REASON,
      voidQuestions: 'this turned out to be a duplicate of the tenant issue',
    });

    expect(await statusOf(issueId)).toBe('dropped');
    const [q] = await questionsOn(issueId);
    expect(q?.status).toBe('void');
    expect(q?.voidReason).toContain('went to Dropped with this question open');
    expect(q?.voidReason).toContain('a duplicate of the tenant issue');
    expect(q?.endedReason).toBe('issue_terminal');
  });

  for (const blank of ['', '   ']) {
    it(`refuses voidQuestions ${JSON.stringify(blank)} by name and changes nothing`, async () => {
      const issueId = await insertIssue('in_progress');
      await openQuestion(issueId);

      const err = await refusalOf(
        transition.transitionIssueStatus(await load(issueId), 'closed', person(), {
          voidQuestions: blank,
        }),
      );

      expect(err.code).toBe('VOID_REASON_REQUIRED');
      expect(await statusOf(issueId)).toBe('in_progress');
      expect((await questionsOn(issueId))[0]?.status).toBe('open');
    });
  }

  it('closes as it always did when every question is answered or void', async () => {
    const issueId = await insertIssue('in_progress');
    await answeredQuestion(issueId);

    await transition.transitionIssueStatus(await load(issueId), 'closed', person());

    expect(await statusOf(issueId)).toBe('closed');
  });
});

describe('a question cannot be asked of finished work', () => {
  for (const terminal of ['closed', 'dropped'] as const) {
    it(`refuses an ask on a ${terminal} issue with QUESTION_ISSUE_TERMINAL and writes no row`, async () => {
      const issueId = await insertIssue(terminal);
      await expect(
        write.askQuestion({
          id: randomUUID(),
          projectId,
          issueId,
          prompt: 'Which tenant?',
          blockerKind: 'human',
          answer: { shape: 'free_text', needed: 'the tenant slug' },
        }),
      ).rejects.toMatchObject({ code: 'QUESTION_ISSUE_TERMINAL' });
      expect(await questionsOn(issueId)).toEqual([]);
    });
  }
});

describe('the device door shares the terminal refusal', () => {
  it('answers 400 QUESTION_ISSUE_TERMINAL for a box asking about a dropped issue, and writes nothing', async () => {
    const { app } = await import('../../src/index.js');
    const { pairDevice } = await import('../helpers/pair-device.js');
    const issued = await pairDevice({ ownerId, name: 'ask-box', platform: 'linux' });
    await harness.db.execute(sql`
      INSERT INTO runners (device_id, project_id, name, type, status)
      VALUES (${issued.device.id}, ${projectId}, 'ask-box', 'claude-code', 'online')
    `);
    const issueId = await insertIssue('dropped', false);

    const res = await app.request('/api/devices/me/questions', {
      method: 'POST',
      headers: { authorization: `Bearer ${issued.plaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: randomUUID(),
        projectId,
        issueId,
        prompt: 'Which tenant?',
        blockerKind: 'human',
        answerShape: 'free_text',
        needed: 'the tenant slug',
      }),
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('QUESTION_ISSUE_TERMINAL');
    expect(await questionsOn(issueId)).toEqual([]);
  });
});

describe('forge_questions — an agent on the MCP server can ask', () => {
  beforeAll(async () => {
    tools = await import('../../src/mcp/tools/forge-questions.js');
  });

  function toolFor(principal = makeFakePrincipal(randomUUID(), ownerId)) {
    return tools.forgeQuestionsTool({ principal, projectSlug: null } as never);
  }

  const choice = {
    options: [
      {
        id: 'a',
        label: 'Ship behind a flag',
        authority: 'writer',
        bindsTo: 'session',
        executedBy: 'agent',
      },
      {
        id: 'b',
        label: 'Hold the release',
        authority: 'writer',
        bindsTo: 'session',
        executedBy: 'agent',
      },
    ],
    recommendedOptionId: 'a',
  };

  it('asks a choice question that get returns with its options', async () => {
    const issueId = await insertIssue('needs_info');
    const tool = toolFor();
    const asked = (await tool.handler({
      action: 'ask',
      data: { issueId, prompt: 'Ship now?', blockerKind: 'human', ...choice },
    })) as { id: string };
    const got = (await tool.handler({ action: 'get', id: asked.id })) as {
      answerShape: string;
      options: Array<{ id: string }>;
      recommendedOptionId: string;
    };
    expect(got.answerShape).toBe('choice');
    expect(got.options.map((o) => o.id)).toEqual(['a', 'b']);
    expect(got.recommendedOptionId).toBe('a');
  });

  it('asks a free-text question carrying the sentence that settles it', async () => {
    const issueId = await insertIssue('needs_info');
    const asked = (await toolFor().handler({
      action: 'ask',
      data: { issueId, prompt: 'Which tenant?', blockerKind: 'human', needed: 'the tenant slug' },
    })) as { id: string };
    const [row] = await questionsOn(issueId);
    expect(row?.id).toBe(asked.id);
    expect(row?.steps[0]).toMatchObject({ answerShape: 'free_text', needed: 'the tenant slug' });
  });

  it('writes the question and leaves the status alone when a person is the blocker', async () => {
    const issueId = await insertIssue('in_progress');
    const principal = makeFakeJobPrincipal(randomUUID(), ownerId, randomUUID(), projectId);
    await toolFor(principal).handler({
      action: 'ask',
      data: { issueId, prompt: 'Ship now?', blockerKind: 'human', ...choice },
    });
    expect(await statusOf(issueId)).toBe('in_progress');
    const rows = await questionsOn(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('open');
  });

  for (const blockerKind of ['machine', 'master_or_peer'] as const) {
    it(`leaves the status alone when the blocker is ${blockerKind}`, async () => {
      const issueId = await insertIssue('in_progress');
      await toolFor().handler({
        action: 'ask',
        data: { issueId, prompt: 'Ship now?', blockerKind, ...choice },
      });
      expect(await statusOf(issueId)).toBe('in_progress');
      expect(await questionsOn(issueId)).toHaveLength(1);
    });
  }

  it('refuses an ask on a closed issue, which no answer could reach', async () => {
    const issueId = await insertIssue('closed');
    await expect(
      toolFor().handler({
        action: 'ask',
        data: { issueId, prompt: 'Ship now?', blockerKind: 'human', ...choice },
      }),
    ).rejects.toThrow(/QUESTION_ISSUE_TERMINAL/);
    expect(await statusOf(issueId)).toBe('closed');
    expect(await questionsOn(issueId)).toEqual([]);
  });

  it('refuses a viewer and writes no row', async () => {
    const issueId = await insertIssue('in_progress');
    const viewer = await createTestUser(harness.db);
    await createTestProjectMember(harness.db, { userId: viewer.id, projectId, role: 'viewer' });
    await expect(
      toolFor(makeFakePrincipal(randomUUID(), viewer.id)).handler({
        action: 'ask',
        data: { issueId, prompt: 'Ship now?', blockerKind: 'human', ...choice },
      }),
    ).rejects.toThrow(/FORBIDDEN/);
    expect(await questionsOn(issueId)).toEqual([]);
    expect(await statusOf(issueId)).toBe('in_progress');
  });
});

describe('every agent entry to needs_info leaves a question', () => {
  it('mints one on the park the rescue cap makes', async () => {
    const issueId = await insertIssue('in_progress');
    await transition.applyStatusTransition(
      await load(issueId),
      'needs_info',
      { id: ownerId, ownerId },
      {
        reason: 'autonomous_rescue_cap_reached',
        transitionReason: 'The driver spent its three rescues on this run.',
        needs: 'Whether to send it back to the driver as it stands.',
        waitingKind: 'needs_decision',
      },
    );
    expect(await statusOf(issueId)).toBe('needs_info');
    const rows = await questionsOn(issueId);
    expect(rows.map((q) => q.status)).toEqual(['open']);
  });
});

describe('a void never erases an answer', () => {
  it('refuses to void an answered question and keeps the answer', async () => {
    const issueId = await insertIssue('in_progress');
    const answered = await answeredQuestion(issueId);
    await expect(
      write.voidQuestion({ questionId: answered, reason: 'no longer needed' }),
    ).rejects.toMatchObject({ code: 'QUESTION_NOT_OPEN' });
    const [row] = await questionsOn(issueId);
    expect(row?.status).toBe('answered');
    expect(row?.steps[0]).toMatchObject({ answerText: 'acme' });
  });
});

describe('the attention count is a count of issues', () => {
  it('counts an issue holding two open questions once', async () => {
    const issueId = await insertIssue('needs_info');
    await openQuestion(issueId);
    await openQuestion(issueId);
    const rows = await attention.selectAwaitingInput(ownerId);
    expect(rows.filter((r) => r.id === issueId)).toHaveLength(1);
  });
});

describe('the two reads the web surfaces are built on', () => {
  async function questionAt(issueId: string | null, blockerKind: string, createdAt: string) {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps, created_at)
      VALUES (${id}, ${projectId}, ${issueId}, 'open', ${blockerKind}, '[]'::jsonb, ${createdAt}::timestamptz)
    `);
    return id;
  }

  it('ages an issue row from its oldest open question blocked on a person', async () => {
    const { issueListPageQuery } = await import('../../src/issues/list-projection.js');
    const waiting = await insertIssue('needs_info');
    const peerOnly = await insertIssue('in_progress');
    await questionAt(waiting, 'human', '2026-09-20T10:00:00Z');
    await questionAt(waiting, 'human', '2026-09-25T10:00:00Z');
    await questionAt(waiting, 'master_or_peer', '2026-09-01T10:00:00Z');
    await questionAt(peerOnly, 'master_or_peer', '2026-09-01T10:00:00Z');

    const rows = await issueListPageQuery({
      where: sql`${sql.raw('"issues"."project_id"')} = ${projectId}`,
      orderBy: sql`1`,
      limit: 10,
      offset: 0,
    });
    const since = (id: string) => rows.find((r) => r.id === id)?.waitingOnPersonSince;
    expect(since(waiting)?.toISOString()).toBe('2026-09-20T10:00:00.000Z');
    expect(since(peerOnly)).toBeNull();
  });

  it('lists only the questions that name no issue when the Questions tab asks for them', async () => {
    const { projectQuestionsFor } = await import('../../src/questions/read.js');
    const onIssue = await questionAt(
      await insertIssue('needs_info'),
      'human',
      '2026-09-20T10:00:00Z',
    );
    const masters = await questionAt(null, 'human', '2026-09-21T10:00:00Z');

    const tab = await projectQuestionsFor(projectId, ownerId, 'open', { limit: 50 }, true);
    expect(tab?.questions.map((q) => q.id)).toEqual([masters]);
    const all = await projectQuestionsFor(projectId, ownerId, 'open', { limit: 50 });
    expect(all?.questions.map((q) => q.id).sort()).toEqual([onIssue, masters].sort());
  });
});
