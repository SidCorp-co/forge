/**
 * ISS-1310 — a park shows the decision the person has. Real Postgres: the park view is read off
 * the rows the page reads, and every move it offers is taken through the transition that would
 * take it from the page.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ws/broadcast.js', () => ({
  broadcast: vi.fn(),
  broadcastToProject: vi.fn(),
}));

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
let parkView: typeof import('../../src/issues/park-view.js');
let jwt: typeof import('../../src/auth/jwt.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  transition = await import('../../src/issues/apply-transition.js');
  parkView = await import('../../src/issues/park-view.js');
  jwt = await import('../../src/auth/jwt.js');
  const { issueParkRoutes } = await import('../../src/issues/park-routes.js');
  const { searchRoutes } = await import('../../src/issues/search.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/issues', issueParkRoutes);
  app.route('/api/projects', searchRoutes);
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

const person = () => ({ type: 'user' as const, id: ownerId });
const agent = () => ({ type: 'user' as const, id: ownerId, agency: 'agent' as const });

async function insertIssue(status: string, waitingKind: string | null = null): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, waiting_kind, created_by_id, assignee_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${waitingKind}, ${ownerId}, ${ownerId})
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

const rowOf = async (id: string) =>
  (
    await harness.db.execute(
      sql`SELECT status, waiting_kind AS "waitingKind" FROM issues WHERE id = ${id}`,
    )
  )[0] as { status: string; waitingKind: string | null };

/** A status move as the transition records it inside its own write, `minutesAgo` before now. */
async function moved(issueId: string, from: string, to: string, minutesAgo: number) {
  await harness.db.execute(sql`
    INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_id, source, created_at)
    VALUES ('issue', ${issueId}, ${from}, ${to}, 'user', ${ownerId}, 'issues',
            now() - ${`${minutesAgo} minutes`}::interval)
  `);
}

/** A status move as the bus subscriber's history row records it, `secondsAgo` before now — negative is later. */
async function historyRow(issueId: string, from: string, to: string, secondsAgo: number) {
  await harness.db.execute(sql`
    INSERT INTO activity_log (issue_id, actor_type, actor_id, action, payload, created_at)
    VALUES (${issueId}, 'user', ${ownerId}, 'issue.statusChanged',
            ${JSON.stringify({ from, to })}::jsonb, now() - ${`${secondsAgo} seconds`}::interval)
  `);
}

async function commented(issueId: string, body: string, minutesAgo: number): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, body, created_at)
    VALUES (${id}, ${issueId}, ${ownerId}, ${body}, now() - ${`${minutesAgo} minutes`}::interval)
  `);
  return id;
}

const parkRecord = (kind: string, left: string) =>
  [
    '## Park',
    '',
    '```forge-record',
    `kind: ${kind}`,
    'why: look at it',
    `left: ${left}`,
    '```',
    '',
    '`forge-record: park · contract 1`',
  ].join('\n');

async function openQuestion(issueId: string, blockerKind = 'human'): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
    VALUES (${id}, ${projectId}, ${issueId}, 'open', ${blockerKind}, '[]'::jsonb)
  `);
  return id;
}

const questionStatuses = async (issueId: string) =>
  (
    await harness.db.execute(
      sql`SELECT status, ended_reason AS "endedReason" FROM agent_questions WHERE issue_id = ${issueId}`,
    )
  ).map((r) => r as { status: string; endedReason: string | null });

const bodies = async (issueId: string) =>
  (
    await harness.db.execute(
      sql`SELECT body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at`,
    )
  ).map((r) => String((r as { body: unknown }).body));

async function getPark(issueId: string) {
  const res = await app.request(`/api/issues/${issueId}/park`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    status: res.status,
    body: (await res.json()) as { park: Record<string, unknown> | null },
  };
}

describe('GET /api/issues/:id/park reads the resume rung off the park record', () => {
  it('answers ISS-529’s shape: waiting, parked after developed, resumes at developed', async () => {
    const issueId = await insertIssue('waiting', 'needs_decision');
    await moved(issueId, 'in_progress', 'developed', 30);
    await moved(issueId, 'developed', 'waiting', 20);
    const recordId = await commented(issueId, parkRecord('screen-review', 'developed'), 19);
    const { status, body } = await getPark(issueId);
    expect(status).toBe(200);
    expect(body.park).toMatchObject({
      shape: 'park',
      status: 'waiting',
      owes: 'decision',
      resume: { at: 'developed', recordId },
    });
  });

  it('pairs a needs_info record written before the move and drops one from an earlier park', async () => {
    const issueId = await insertIssue('needs_info');
    await commented(issueId, parkRecord('screen-review', 'testing'), 60);
    await moved(issueId, 'waiting', 'approved', 40);
    const recordId = await commented(issueId, parkRecord('question', 'approved'), 21);
    await moved(issueId, 'approved', 'needs_info', 20);
    const { body } = await getPark(issueId);
    expect(body.park?.resume).toEqual({ at: 'approved', recordId });
  });

  it('says no rung was recorded rather than defaulting one', async () => {
    const issueId = await insertIssue('needs_info');
    await moved(issueId, 'in_progress', 'developed', 30);
    await moved(issueId, 'developed', 'needs_info', 20);
    const { body } = await getPark(issueId);
    expect(body.park).toMatchObject({ resume: { at: null } });
    expect(body.park?.record).toBeNull();
  });

  it('keeps its own boundary after more park-to-park moves than a page of history holds', async () => {
    const issueId = await insertIssue('needs_info');
    await commented(issueId, parkRecord('screen-review', 'testing'), 200);
    await moved(issueId, 'waiting', 'developed', 180);
    await moved(issueId, 'developed', 'needs_info', 170);
    for (let i = 0; i < 51; i += 1) {
      const [from, to] = i % 2 === 0 ? ['needs_info', 'waiting'] : ['waiting', 'needs_info'];
      await moved(issueId, from, to, 160 - i);
    }
    await moved(issueId, 'waiting', 'needs_info', 100);
    const { body } = await getPark(issueId);
    expect(body.park).toMatchObject({ resume: { at: null } });
    expect(body.park?.record).toBeNull();
  });

  it('pairs the record whatever time the history row lands at (judge j1, scratch ISS-5)', async () => {
    const issueId = await insertIssue('on_hold');
    await transition.transitionIssueStatus(await load(issueId), 'in_progress', person());
    const recordId = await commented(issueId, parkRecord('question', 'in_progress'), 0);
    await transition.transitionIssueStatus(await load(issueId), 'needs_info', person(), {
      reason: 'the export order is not stated',
      transitionReason: 'the export order is not stated',
    });
    await historyRow(issueId, 'on_hold', 'in_progress', -10);
    await historyRow(issueId, 'in_progress', 'needs_info', -10);
    const { body } = await getPark(issueId);
    expect(body.park?.resume).toEqual({ at: 'in_progress', recordId });
  });

  it('does not pair a record from an earlier park while the boundary’s history row is still unwritten', async () => {
    const issueId = await insertIssue('on_hold');
    await commented(issueId, parkRecord('screen-review', 'testing'), 1);
    await transition.transitionIssueStatus(await load(issueId), 'in_progress', person());
    await transition.transitionIssueStatus(await load(issueId), 'needs_info', person(), {
      reason: 'stopped again',
      transitionReason: 'stopped again',
    });
    const { body } = await getPark(issueId);
    expect(body.park).toMatchObject({ resume: { at: null }, record: null });
  });

  it('offers no resume status, and says why, where the park began before moves were recorded in their own write', async () => {
    const issueId = await insertIssue('needs_info');
    await historyRow(issueId, 'open', 'in_progress', 3600);
    await commented(issueId, parkRecord('question', 'in_progress'), 30);
    await historyRow(issueId, 'in_progress', 'needs_info', 1200);
    const { body } = await getPark(issueId);
    expect(body.park).toMatchObject({ shape: 'park', resume: { at: null }, record: null });
    expect(body.park?.resume).toHaveProperty(
      'why',
      expect.stringContaining('before Forge recorded'),
    );
  });

  it('refuses the same where only the move before the park predates that record', async () => {
    const issueId = await insertIssue('needs_info');
    await historyRow(issueId, 'open', 'in_progress', 3600);
    await commented(issueId, parkRecord('question', 'in_progress'), 30);
    await moved(issueId, 'in_progress', 'needs_info', 20);
    const { body } = await getPark(issueId);
    expect(body.park).toMatchObject({ resume: { at: null }, record: null });
  });

  it('pairs any record where the issue went into its park without an earlier move', async () => {
    const issueId = await insertIssue('needs_info');
    const recordId = await commented(issueId, parkRecord('question', 'open'), 30);
    await moved(issueId, 'open', 'needs_info', 20);
    const { body } = await getPark(issueId);
    expect(body.park?.resume).toEqual({ at: 'open', recordId });
  });

  it('answers null for an issue nobody owes anything, and 404 for none at all', async () => {
    const issueId = await insertIssue('in_progress');
    expect((await getPark(issueId)).body.park).toBeNull();
    expect((await getPark(randomUUID())).status).toBe(404);
  });
});

describe('the answer a question asked in the thread has', () => {
  it('is a person’s comment later than the park record, and never the move’s announcement', async () => {
    const issueId = await insertIssue('on_hold');
    await transition.transitionIssueStatus(await load(issueId), 'in_progress', person());
    await commented(issueId, parkRecord('question', 'in_progress'), 0);
    await transition.transitionIssueStatus(await load(issueId), 'needs_info', person(), {
      reason: 'should the export keep the legacy column order?',
      transitionReason: 'should the export keep the legacy column order?',
    });
    expect((await getPark(issueId)).body.park?.answer).toBeNull();
    const [reply] = (
      await harness.db.execute(sql`
        INSERT INTO comments (id, issue_id, author_id, body, created_at)
        VALUES (${randomUUID()}, ${issueId}, ${ownerId}, 'keep the legacy order', now() + interval '1 second')
        RETURNING id
      `)
    ).map((r) => String((r as { id: unknown }).id));
    expect((await getPark(issueId)).body.park?.answer).toMatchObject({
      commentId: reply,
      text: 'keep the legacy order',
    });
  });
});

describe('an answer behind a long thread', () => {
  it('is still the answer after more typed records than a page holds', async () => {
    const issueId = await insertIssue('needs_info');
    await moved(issueId, 'open', 'in_progress', 60);
    await commented(issueId, parkRecord('question', 'in_progress'), 50);
    await moved(issueId, 'in_progress', 'needs_info', 49);
    const answerId = await commented(issueId, 'keep the legacy order', 40);
    for (let i = 0; i < 60; i += 1) {
      await commented(
        issueId,
        ['```forge-record', `note: ${i}`, '```', '', '`forge-record: note · contract 1`'].join(
          '\n',
        ),
        30 - i / 10,
      );
    }
    expect((await getPark(issueId)).body.park?.answer).toMatchObject({ commentId: answerId });
  });
});

describe('the park view exists for the issues Blocked on a person lists, but the one set on hold', () => {
  it('agrees with the search Blocked on a person reads, row for row, bar an issue nobody asked anything of', async () => {
    const ids = {
      needsInfo: await insertIssue('needs_info'),
      waiting: await insertIssue('waiting', 'needs_resource'),
      marked: await insertIssue('testing'),
      peerOnly: await insertIssue('testing'),
      working: await insertIssue('in_progress'),
      held: await insertIssue('on_hold'),
    };
    await openQuestion(ids.marked);
    await openQuestion(ids.peerOnly, 'master_or_peer');
    const res = await app.request(
      `/api/projects/${projectId}/issues/search?workState=blocked_on_person`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const listed = ((await res.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id);
    const viewed: string[] = [];
    for (const id of Object.values(ids)) {
      if (await parkView.loadIssuePark(id)) viewed.push(id);
    }
    expect(listed.sort()).toEqual([ids.needsInfo, ids.waiting, ids.marked, ids.held].sort());
    expect(viewed.sort()).toEqual(listed.filter((id) => id !== ids.held).sort());
  });
});

describe('the moves the park menu sends', () => {
  it('resumes a waiting park at developed, a target the map does not list at waiting', async () => {
    const issueId = await insertIssue('waiting', 'needs_decision');
    await transition.transitionIssueStatus(await load(issueId), 'developed', person());
    expect((await rowOf(issueId)).status).toBe('developed');
  });

  it('posts a person’s reason for leaving a park on the thread', async () => {
    const issueId = await insertIssue('needs_info');
    await transition.transitionIssueStatus(await load(issueId), 'in_progress', person(), {
      reason: 'answered on a call',
      transitionReason: 'answered on a call',
    });
    const posted = await bodies(issueId);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('Left `needs_info` for `in_progress`');
    expect(posted[0]).toContain('answered on a call');
  });

  it('names both statuses once, in the park announcement, where the move enters another park', async () => {
    const issueId = await insertIssue('needs_info');
    await transition.transitionIssueStatus(await load(issueId), 'waiting', person(), {
      reason: 'needs a login, not an answer',
      transitionReason: 'needs a login, not an answer',
      waitingKind: 'needs_resource',
    });
    const posted = await bodies(issueId);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('moved from `needs_info`');
    expect(posted[0]).toContain('supply something');
    expect(posted[0]).toContain('needs a login, not an answer');
  });

  it('posts nothing for a move out of a park that carries no reason, or an agent’s', async () => {
    const quiet = await insertIssue('waiting', 'needs_decision');
    await transition.transitionIssueStatus(await load(quiet), 'in_progress', person());
    const byAgent = await insertIssue('needs_info');
    await transition.transitionIssueStatus(await load(byAgent), 'in_progress', agent(), {
      transitionReason: 'resuming',
    });
    expect(await bodies(quiet)).toEqual([]);
    expect(await bodies(byAgent)).toEqual([]);
  });

  it('voids the open questions and resumes in one write when the question is not needed', async () => {
    const issueId = await insertIssue('needs_info');
    await openQuestion(issueId);
    await openQuestion(issueId);
    await transition.transitionIssueStatus(await load(issueId), 'approved', person(), {
      reason: 'decided in standup',
      transitionReason: 'decided in standup',
      voidQuestions: 'decided in standup',
    });
    expect((await rowOf(issueId)).status).toBe('approved');
    expect(await questionStatuses(issueId)).toEqual([
      { status: 'void', endedReason: 'not_needed' },
      { status: 'void', endedReason: 'not_needed' },
    ]);
  });

  it('refuses a blank reason and moves nothing, voiding nothing', async () => {
    const issueId = await insertIssue('needs_info');
    await openQuestion(issueId);
    await expect(
      transition.transitionIssueStatus(await load(issueId), 'approved', person(), {
        voidQuestions: '   ',
      }),
    ).rejects.toMatchObject({ code: 'VOID_REASON_REQUIRED' });
    expect((await rowOf(issueId)).status).toBe('needs_info');
    expect(await questionStatuses(issueId)).toEqual([{ status: 'open', endedReason: null }]);
  });
});

describe('a park asking for a decision or a resource keeps what it asks for', () => {
  it('keeps the kind and mints the question when the agent’s waiting park is rewritten to needs_info', async () => {
    const issueId = await insertIssue('in_progress');
    await transition.transitionIssueStatus(await load(issueId), 'waiting', agent(), {
      transitionReason: 'No Search Console login on this box.',
      waitingKind: 'needs_resource',
      needs: 'a Search Console login for the property',
    });
    expect(await rowOf(issueId)).toEqual({ status: 'needs_info', waitingKind: 'needs_resource' });
    const park = await parkView.loadIssuePark(issueId);
    expect(park?.owes).toBe('resource');
    expect(park?.openQuestionIds).toHaveLength(1);
  });

  it('stores no kind on a park that asked for none, which reads as information', async () => {
    const issueId = await insertIssue('in_progress');
    await transition.transitionIssueStatus(await load(issueId), 'needs_info', agent(), {
      transitionReason: 'Which tenant?',
      needs: 'the tenant slug',
    });
    expect(await rowOf(issueId)).toEqual({ status: 'needs_info', waitingKind: null });
    expect((await parkView.loadIssuePark(issueId))?.owes).toBe('information');
  });

  it('clears the kind once the issue leaves the park', async () => {
    const issueId = await insertIssue('needs_info', 'needs_decision');
    await transition.transitionIssueStatus(await load(issueId), 'approved', person());
    expect(await rowOf(issueId)).toEqual({ status: 'approved', waitingKind: null });
  });
});
