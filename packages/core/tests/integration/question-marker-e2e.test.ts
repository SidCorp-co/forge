/**
 * ISS-1257 — a question marks its issue and moves nothing, and an answer moves only a
 * `needs_info` park. Real Postgres: every claim is what `issues` and `agent_questions` hold, or
 * what a read built on them returns, after the act.
 */

import { randomUUID } from 'node:crypto';
import { type SQL, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ws/broadcast.js', () => ({
  broadcast: vi.fn(),
  broadcastToProject: vi.fn(),
}));

import { makeFakeJobPrincipal } from '../../src/mcp/fake-principal.fixture.js';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type IssueRow = import('../../src/issues/apply-transition.js').TransitionIssueRow;

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let token: string;
let app: Hono<{ Variables: RequestIdVars }>;
let seq = 0;

let transition: typeof import('../../src/issues/apply-transition.js');
let write: typeof import('../../src/questions/write.js');
let tools: typeof import('../../src/mcp/tools/forge-questions.js');
let attention: typeof import('../../src/me/attention-buckets.js');
let reconciler: typeof import('../../src/pipeline/reconciler.js');
let jwt: typeof import('../../src/auth/jwt.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  transition = await import('../../src/issues/apply-transition.js');
  write = await import('../../src/questions/write.js');
  tools = await import('../../src/mcp/tools/forge-questions.js');
  attention = await import('../../src/me/attention-buckets.js');
  reconciler = await import('../../src/pipeline/reconciler.js');
  jwt = await import('../../src/auth/jwt.js');
  const resume = await import('../../src/pipeline/answer-resume.js');
  const hooksMod = await import('../../src/pipeline/hooks.js');
  resume.registerAnswerResume(hooksMod.hooks);

  const { searchRoutes } = await import('../../src/issues/search.js');
  const { questionRoutes } = await import('../../src/questions/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', searchRoutes);
  app.route('/api/questions', questionRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${ownerId}`);
  projectId = (await createTestProject(harness.db, ownerId)).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  token = await jwt.signUserToken(ownerId);
});

async function insertIssue(status: string, updatedAt: SQL = sql`now()`): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, assignee_id, updated_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId}, ${ownerId}, ${updatedAt})
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

async function openQuestion(issueId: string, blockerKind = 'human'): Promise<string> {
  const id = randomUUID();
  const step = {
    round: 1,
    prompt: 'Publish now, or hold for the copy change?',
    askedAt: '2026-09-27T10:00:00Z',
    answerShape: 'free_text',
    needed: 'publish or hold',
  };
  await harness.db.execute(sql`
    INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
    VALUES (${id}, ${projectId}, ${issueId}, 'open', ${blockerKind}, ${JSON.stringify([step])}::jsonb)
  `);
  return id;
}

async function openQuestionsOn(issueId: string): Promise<string[]> {
  const rows = await harness.db.execute(sql`
    SELECT id FROM agent_questions WHERE issue_id = ${issueId} AND status = 'open' ORDER BY created_at
  `);
  return rows.map((r) => (r as { id: string }).id);
}

async function answer(questionId: string) {
  await write.answerQuestion({
    questionId,
    answer: { kind: 'text', text: 'publish it' },
    round: 1,
    by: ownerId,
    role: 'admin',
    via: 'web',
  });
}

async function lockWaiter() {
  for (let i = 0; i < 200; i++) {
    const rows = await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND datname = current_database()
    `);
    if ((rows[0] as { n: number }).n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('nothing waited on the issue row this test holds');
}

/**
 * Holds an ask in flight — the issue row share-locked as the ask path locks it, and a question
 * for a person written but not committed — while `act` starts, then commits once `act` waits.
 */
async function whileAnAskIsInFlight<T>(issueId: string, act: () => Promise<T>): Promise<T> {
  let acted: Promise<T> | undefined;
  await harness.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM issues WHERE id = ${issueId} FOR SHARE`);
    await tx.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
      VALUES (${randomUUID()}, ${projectId}, ${issueId}, 'open', 'human', '[]'::jsonb)
    `);
    acted = act();
    acted.catch(() => {});
    await lockWaiter();
  });
  return acted as Promise<T>;
}

const prompt = 'Publish now, or hold for the copy change?';
const choice = {
  options: [
    {
      id: 'publish',
      label: 'Publish it',
      authority: 'writer',
      bindsTo: 'session',
      executedBy: 'agent',
    },
    { id: 'hold', label: 'Hold it', authority: 'writer', bindsTo: 'session', executedBy: 'agent' },
  ],
  recommendedOptionId: 'publish',
};

describe('an ask marks the issue and moves nothing', () => {
  it('leaves an issue at testing where it is when an agent asks a person through forge_questions', async () => {
    const issueId = await insertIssue('testing');
    const principal = makeFakeJobPrincipal(randomUUID(), ownerId, randomUUID(), projectId);
    const tool = tools.forgeQuestionsTool({ principal, projectSlug: null } as never);
    const asked = (await tool.handler({
      action: 'ask',
      data: { issueId, prompt, blockerKind: 'human', ...choice },
    })) as { id: string };
    expect(await statusOf(issueId)).toBe('testing');
    expect(await openQuestionsOn(issueId)).toEqual([asked.id]);
  });

  it('leaves an issue at testing where it is when a person asks through POST /api/questions', async () => {
    const issueId = await insertIssue('testing');
    const res = await app.request('/api/questions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueId, prompt, blockerKind: 'human', ...choice }),
    });
    expect(res.status).toBe(201);
    const asked = (await res.json()) as { id: string };
    expect(await statusOf(issueId)).toBe('testing');
    expect(await openQuestionsOn(issueId)).toEqual([asked.id]);
  });
});

describe('an answer moves only a needs_info park', () => {
  it('returns an answered park to open, the one status a master admits', async () => {
    const issueId = await insertIssue('needs_info');
    await answer(await openQuestion(issueId));
    expect(await statusOf(issueId)).toBe('open');
  });

  for (const status of ['testing', 'in_progress', 'developed', 'awaiting_release'] as const) {
    it(`leaves an issue at ${status} where it is when its question is answered`, async () => {
      const issueId = await insertIssue(status);
      await answer(await openQuestion(issueId));
      expect(await statusOf(issueId)).toBe(status);
    });
  }
});

describe('a park on an issue that already waits on a person asks nothing twice', () => {
  const agent = () => ({ type: 'user' as const, id: ownerId, agency: 'agent' as const });

  it('writes no second question when the park names no need', async () => {
    const issueId = await insertIssue('in_progress');
    const first = await openQuestion(issueId);
    await transition.transitionIssueStatus(await load(issueId), 'needs_info', agent(), {
      transitionReason: 'Waiting on the publish decision asked above.',
    });
    expect(await statusOf(issueId)).toBe('needs_info');
    expect(await openQuestionsOn(issueId)).toEqual([first]);
  });

  it('still mints one when the park says what it needs', async () => {
    const issueId = await insertIssue('in_progress');
    await openQuestion(issueId);
    await transition.transitionIssueStatus(await load(issueId), 'needs_info', agent(), {
      transitionReason: 'A second thing is missing.',
      needs: 'the tenant slug',
    });
    expect(await openQuestionsOn(issueId)).toHaveLength(2);
  });

  it('asks nothing twice when a person is asked while the park is being written', async () => {
    const issueId = await insertIssue('in_progress');
    const row = await load(issueId);
    await whileAnAskIsInFlight(issueId, () =>
      transition.transitionIssueStatus(row, 'needs_info', agent(), {
        transitionReason: 'Stopped for a person.',
      }),
    );
    expect(await statusOf(issueId)).toBe('needs_info');
    expect(await openQuestionsOn(issueId)).toHaveLength(1);
  });

  it('mints one when the only open question is a peer’s', async () => {
    const issueId = await insertIssue('in_progress');
    await openQuestion(issueId, 'master_or_peer');
    await transition.transitionIssueStatus(await load(issueId), 'needs_info', agent(), {
      transitionReason: 'Stopped for a person.',
    });
    expect(await openQuestionsOn(issueId)).toHaveLength(2);
  });
});

describe('the reads a person looks at see the marker as well as the status', () => {
  async function search(query: string) {
    const res = await app.request(`/api/projects/${projectId}/issues/search?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      items: Array<{ id: string }>;
      buckets?: {
        byStatus: Record<string, number>;
        waitingOnPersonByStatus: Record<string, number>;
      };
    };
  }

  const NEEDS_YOU = 'status=needs_info&status=waiting&orWaitingOnPerson=true';

  it('lists an issue at testing holding a person’s question under Needs you, beside a needs_info park', async () => {
    const marked = await insertIssue('testing');
    await openQuestion(marked);
    const parked = await insertIssue('needs_info');
    const peerOnly = await insertIssue('testing');
    await openQuestion(peerOnly, 'master_or_peer');
    const body = await search(NEEDS_YOU);
    expect(body.items.map((i) => i.id).sort()).toEqual([marked, parked].sort());
  });

  it('drops the issue from Needs you once its last question for a person is answered', async () => {
    const marked = await insertIssue('testing');
    await answer(await openQuestion(marked));
    const body = await search(NEEDS_YOU);
    expect(body.items).toEqual([]);
    expect(await attention.selectAwaitingInput(ownerId)).toEqual([]);
  });

  it('refuses orWaitingOnPerson sent with no status to widen, by name', async () => {
    const res = await app.request(
      `/api/projects/${projectId}/issues/search?orWaitingOnPerson=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/orWaitingOnPerson/);
  });

  it('counts marker holders by status in the buckets, once per issue', async () => {
    const marked = await insertIssue('testing');
    await openQuestion(marked);
    await openQuestion(marked);
    await insertIssue('testing');
    const body = await search('withBuckets=true');
    expect(body.buckets?.waitingOnPersonByStatus).toEqual({ testing: 1 });
    expect(body.buckets?.byStatus.testing).toBe(2);
  });

  it('puts an issue at testing holding a person’s question in the viewer’s Attention', async () => {
    const issueId = await insertIssue('testing');
    await openQuestion(issueId);
    const rows = await attention.selectAwaitingInput(ownerId);
    expect(rows.map((r) => r.id)).toEqual([issueId]);
  });

  it('counts an issue at developed holding a person’s question once, as awaiting input', async () => {
    const issueId = await insertIssue('developed');
    await openQuestion(issueId);
    const review = await attention.selectNeedsReview(ownerId);
    const awaiting = await attention.selectAwaitingInput(ownerId);
    expect(review.map((r) => r.id)).toEqual([]);
    expect(awaiting.map((r) => r.id)).toEqual([issueId]);
  });
});

describe('the wedge reset leaves an issue a person owes an answer', () => {
  async function wedged(): Promise<string> {
    const issueId = await insertIssue('in_progress', sql`now() - interval '2 days'`);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at, finished_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'failed', now() - interval '2 days',
              now() - interval '2 days')
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, payload, queued_at,
                        created_by, created_at)
      VALUES (${randomUUID()}, ${projectId}, ${issueId}, ${runId}, 'drive', 'failed', '{}'::jsonb,
              now() - interval '2 days', ${ownerId}, now() - interval '2 days')
    `);
    await harness.db.execute(
      sql`UPDATE issues SET updated_at = now() - interval '2 days' WHERE id = ${issueId}`,
    );
    return issueId;
  }

  it('keeps an in-flight issue holding a person’s question at its status', async () => {
    const issueId = await wedged();
    await openQuestion(issueId);
    await reconciler.resetAutonomousWedgesOnce();
    expect(await statusOf(issueId)).toBe('in_progress');
  });

  it('keeps an issue whose person was asked after the wedge read chose it', async () => {
    const issueId = await wedged();
    const reset = await whileAnAskIsInFlight(issueId, () => reconciler.resetAutonomousWedgesOnce());
    expect(reset).toBe(0);
    expect(await statusOf(issueId)).toBe('in_progress');
  });

  it('still resets a wedged issue that holds no such question', async () => {
    const issueId = await wedged();
    await openQuestion(issueId, 'machine');
    await reconciler.resetAutonomousWedgesOnce();
    expect(await statusOf(issueId)).toBe('open');
  });
});
