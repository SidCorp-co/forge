/**
 * ISS-1257 — an answer returns its issue to the driver only once nothing on it is left to answer,
 * and still reaches the session that asked. Real Postgres: the claim is what `issues` and
 * `session_inbox` hold after the answer's hook has run.
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
let resume: typeof import('../../src/pipeline/answer-resume.js');
let hooksMod: typeof import('../../src/pipeline/hooks.js');
let read: typeof import('../../src/questions/read.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  transition = await import('../../src/issues/apply-transition.js');
  write = await import('../../src/questions/write.js');
  resume = await import('../../src/pipeline/answer-resume.js');
  hooksMod = await import('../../src/pipeline/hooks.js');
  read = await import('../../src/questions/read.js');
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, ownerId)).id;
});

async function insertIssue(status: string): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId})
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

const statusOf = async (id: string) => (await load(id)).status;
const person = () => ({ type: 'user' as const, id: ownerId });

async function openQuestion(issueId: string): Promise<string> {
  const id = randomUUID();
  const step = {
    round: 1,
    prompt: 'Which tenant?',
    askedAt: '2026-09-27T10:00:00Z',
    answerShape: 'free_text',
    needed: 'the tenant slug',
  };
  await harness.db.execute(sql`
    INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
    VALUES (${id}, ${projectId}, ${issueId}, 'open', 'human', ${JSON.stringify([step])}::jsonb)
  `);
  return id;
}

async function refusalOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as InstanceType<typeof transition.TransitionError>;
  }
  throw new Error('the call was expected to be refused and it went through');
}

describe('answering returns the issue only when nothing is left to answer', () => {
  beforeAll(() => {
    resume.registerAnswerResume(hooksMod.hooks);
  });

  async function answer(questionId: string) {
    await write.answerQuestion({
      questionId,
      answer: { kind: 'text', text: 'acme' },
      round: 1,
      by: ownerId,
      role: 'admin',
    });
  }

  it('leaves the issue at needs_info while a second question is open', async () => {
    const issueId = await insertIssue('needs_info');
    const first = await openQuestion(issueId);
    await openQuestion(issueId);
    await answer(first);
    expect(await statusOf(issueId)).toBe('needs_info');
  });

  it('holds the resume when a question is open by the time the resume write locks the row', async () => {
    const issueId = await insertIssue('needs_info');
    const late = await openQuestion(issueId);
    const err = await refusalOf(
      transition.transitionIssueStatus(await load(issueId), 'open', person(), {
        requireNoOpenQuestions: true,
      }),
    );
    expect(err.code).toBe('OPEN_QUESTIONS');
    expect(err.detail).toContain(late);
    expect(await statusOf(issueId)).toBe('needs_info');
  });

  it('still hands the answer to the parked session while a sibling question keeps the issue', async () => {
    const issueId = await insertIssue('needs_info');
    const device = await createTestDevice(harness.db, ownerId);
    const runId = randomUUID();
    const sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running', now())
    `);
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, kind, status, pipeline_run_id,
                                  runtime_state)
      VALUES (${sessionId}, ${projectId}, ${device.id}, 'pipeline', 'running', ${runId},
              'awaiting_input')
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, type, status, agent_session_id, pipeline_run_id,
                        payload, queued_at, dispatched_at, created_by)
      VALUES (${randomUUID()}, ${projectId}, ${issueId}, 'drive', 'running', ${sessionId}, ${runId},
              '{}'::jsonb, now(), now(), ${ownerId})
    `);
    const first = await openQuestion(issueId);
    await openQuestion(issueId);

    await answer(first);

    const sent = await harness.db.execute(sql`
      SELECT kind, intent_id AS "intentId", body FROM session_inbox WHERE agent_session_id = ${sessionId}
    `);
    expect(sent).toEqual([{ kind: 'answer', intentId: first, body: 'acme' }]);
    expect(await statusOf(issueId)).toBe('needs_info');
  });

  it('returns it to open when the last open question is answered', async () => {
    const issueId = await insertIssue('needs_info');
    const only = await openQuestion(issueId);
    await answer(only);
    expect(await statusOf(issueId)).toBe('open');
  });
});

describe('a person ask whose status read goes stale before its write', () => {
  async function lockWaiter() {
    for (let i = 0; i < 200; i++) {
      const rows = await harness.db.execute(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()
      `);
      if ((rows[0] as { n: number }).n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the ask never waited on the row this test holds locked');
  }

  /** Moves the issue under a held row lock, starts the ask, and lets the move commit once the ask waits. */
  async function askWhileMoving(issueId: string, to: string) {
    let asked: ReturnType<typeof read.askAs> | undefined;
    await harness.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM issues WHERE id = ${issueId} FOR UPDATE`);
      await tx.execute(sql`UPDATE issues SET status = ${to} WHERE id = ${issueId}`);
      asked = read.askAs({
        userId: ownerId,
        actor: person(),
        issueId,
        prompt: 'Which tenant?',
        blockerKind: 'human',
        answer: { shape: 'free_text', needed: 'the tenant slug' },
      });
      asked.catch(() => {});
      await lockWaiter();
    });
    return asked;
  }

  async function openOn(issueId: string) {
    const rows = await harness.db.execute(sql`
      SELECT id FROM agent_questions WHERE issue_id = ${issueId} AND status = 'open'
    `);
    return rows.map((r) => (r as { id: string }).id);
  }

  it('parks the issue again when a resume took it to open after the ask read needs_info', async () => {
    const issueId = await insertIssue('needs_info');
    const asked = await askWhileMoving(issueId, 'open');
    expect(await statusOf(issueId)).toBe('needs_info');
    expect(await openOn(issueId)).toEqual([(asked as { id: string }).id]);
  });

  it('writes the question alone when another park reached needs_info after the ask read open', async () => {
    const issueId = await insertIssue('open');
    const asked = await askWhileMoving(issueId, 'needs_info');
    expect(await statusOf(issueId)).toBe('needs_info');
    expect(await openOn(issueId)).toEqual([(asked as { id: string }).id]);
  });
});
