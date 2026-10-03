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
const person = () => ({ type: 'user' as const, id: ownerId, agency: 'human' as const });

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
      via: 'web',
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

  it('returns it to open when the last open question is answered on a project that admits nothing at confirmed', async () => {
    const issueId = await insertIssue('needs_info');
    const only = await openQuestion(issueId);
    await answer(only);
    expect(await statusOf(issueId)).toBe('open');
  });
});
