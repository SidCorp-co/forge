/**
 * ISS-1310 — a park shows the decision the person has; where it resumes is `issue_work_state.left_status` (ISS-54). Real Postgres: the park view is read off
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

const person = () => ({ type: 'user' as const, id: ownerId, agency: 'human' as const });
const agent = () => ({ type: 'user' as const, id: ownerId, agency: 'agent' as const });

async function insertIssue(status: string, kind: string | null = null): Promise<string> {
  const waitingKind = kind ?? (status === 'needs_info' ? 'needs_answer' : null);
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, waiting_kind, created_by_id, assignee_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${waitingKind}, ${ownerId}, ${ownerId})
  `);
  return id;
}

/** The status a park was set down from, as the transition into it records it. */
async function leftFrom(issueId: string, status: string) {
  await harness.db.execute(sql`
    INSERT INTO issue_work_state (issue_id, left_status) VALUES (${issueId}, ${status})
    ON CONFLICT (issue_id) DO UPDATE SET left_status = excluded.left_status
  `);
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
    INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, actor_id, source, created_at)
    VALUES ('issue', ${issueId}, ${from}, ${to}, 'user', 'human', ${ownerId}, 'issues',
            now() - ${`${minutesAgo} minutes`}::interval)
  `);
}

/** A status move as the bus subscriber's history row records it, `secondsAgo` before now — negative is later. */
async function historyRow(issueId: string, from: string, to: string, secondsAgo: number) {
  await harness.db.execute(sql`
    INSERT INTO activity_log (issue_id, actor_type, actor_id, actor_agency, action, payload, created_at)
    VALUES (${issueId}, 'user', ${ownerId}, 'human', 'issue.statusChanged',
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

describe('GET /api/issues/:id/park reads the resume status off the work state', () => {
  it('answers ISS-529’s shape: a decision park set down from in_progress resumes there', async () => {
    const issueId = await insertIssue('needs_info', 'needs_decision');
    await leftFrom(issueId, 'in_progress');
    await moved(issueId, 'open', 'in_progress', 30);
    await moved(issueId, 'in_progress', 'needs_info', 20);
    const recordId = await commented(issueId, parkRecord('screen-review', 'in_progress'), 19);
    const { status, body } = await getPark(issueId);
    expect(status).toBe(200);
    expect(body.park).toMatchObject({
      shape: 'park',
      status: 'needs_info',
      owes: 'decision',
      resume: { at: 'in_progress', recordId },
    });
  });

  it('resumes where the work state says, whatever the park record’s `left` line claims', async () => {
    const issueId = await insertIssue('needs_info');
    await leftFrom(issueId, 'approved');
    await moved(issueId, 'approved', 'needs_info', 20);
    const recordId = await commented(issueId, parkRecord('question', 'awaiting_release'), 19);
    const { body } = await getPark(issueId);
    expect(body.park?.resume).toEqual({ at: 'approved', recordId });
  });

  it('pairs a needs_info record written before the move and drops one from an earlier park', async () => {
    const issueId = await insertIssue('needs_info');
    await leftFrom(issueId, 'approved');
    await commented(issueId, parkRecord('screen-review', 'in_progress'), 60);
    await moved(issueId, 'on_hold', 'approved', 40);
    const recordId = await commented(issueId, parkRecord('question', 'approved'), 21);
    await moved(issueId, 'approved', 'needs_info', 20);
    const { body } = await getPark(issueId);
    expect(body.park?.resume).toEqual({ at: 'approved', recordId });
  });

  it('says no status was recorded rather than guessing one from the history', async () => {
    const issueId = await insertIssue('needs_info');
    await moved(issueId, 'open', 'in_progress', 30);
    await moved(issueId, 'in_progress', 'needs_info', 20);
    const { body } = await getPark(issueId);
    expect(body.park).toMatchObject({ resume: { at: null } });
    expect(body.park?.resume).toHaveProperty(
      'why',
      expect.stringContaining('before Forge kept the status a park leaves'),
    );
    expect(body.park?.record).toBeNull();
  });

  it('keeps its own boundary after more park-to-park moves than a page of history holds', async () => {
    const issueId = await insertIssue('needs_info');
    await leftFrom(issueId, 'in_progress');
    await commented(issueId, parkRecord('screen-review', 'in_progress'), 200);
    await moved(issueId, 'on_hold', 'in_progress', 180);
    await moved(issueId, 'in_progress', 'needs_info', 170);
    for (let i = 0; i < 51; i += 1) {
      const [from, to] = i % 2 === 0 ? ['needs_info', 'on_hold'] : ['on_hold', 'needs_info'];
      await moved(issueId, from, to, 160 - i);
    }
    await moved(issueId, 'on_hold', 'needs_info', 100);
    const { body } = await getPark(issueId);
    expect(body.park?.resume).toEqual({ at: 'in_progress', recordId: null });
    expect(body.park?.record).toBeNull();
  });

  it('pairs the record whatever time the history row lands at (judge j1, scratch ISS-5)', async () => {
    const issueId = await insertIssue('on_hold');
    await leftFrom(issueId, 'in_progress');
    await transition.transitionIssueStatus(await load(issueId), 'in_progress', person());
    const recordId = await commented(issueId, parkRecord('question', 'in_progress'), 0);
    await transition.transitionIssueStatus(await load(issueId), 'needs_info', person(), {
      reason: 'the export order is not stated',
      transitionReason: 'the export order is not stated',
      waitingKind: 'needs_answer',
    });
    await historyRow(issueId, 'on_hold', 'in_progress', -10);
    await historyRow(issueId, 'in_progress', 'needs_info', -10);
    const { body } = await getPark(issueId);
    expect(body.park?.resume).toEqual({ at: 'in_progress', recordId });
  });

  it('does not pair a record from an earlier park while the boundary’s history row is still unwritten', async () => {
    const issueId = await insertIssue('on_hold');
    await leftFrom(issueId, 'in_progress');
    await commented(issueId, parkRecord('screen-review', 'in_progress'), 1);
    await transition.transitionIssueStatus(await load(issueId), 'in_progress', person());
    await transition.transitionIssueStatus(await load(issueId), 'needs_info', person(), {
      reason: 'stopped again',
      transitionReason: 'stopped again',
      waitingKind: 'needs_answer',
    });
    const { body } = await getPark(issueId);
    expect(body.park).toMatchObject({
      resume: { at: 'in_progress', recordId: null },
      record: null,
    });
  });

  it('offers no resume status where the park began before Forge kept one, though its record says one', async () => {
    const issueId = await insertIssue('needs_info');
    await historyRow(issueId, 'open', 'in_progress', 3600);
    await commented(issueId, parkRecord('question', 'in_progress'), 30);
    await historyRow(issueId, 'in_progress', 'needs_info', 1200);
    const { body } = await getPark(issueId);
    expect(body.park).toMatchObject({ shape: 'park', resume: { at: null } });
    expect(body.park?.resume).toHaveProperty(
      'why',
      expect.stringContaining('before Forge kept the status a park leaves'),
    );
  });

  it('pairs any record where the issue went into its park without an earlier move', async () => {
    const issueId = await insertIssue('needs_info');
    await leftFrom(issueId, 'open');
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
    await leftFrom(issueId, 'in_progress');
    await transition.transitionIssueStatus(await load(issueId), 'in_progress', person());
    await commented(issueId, parkRecord('question', 'in_progress'), 0);
    await transition.transitionIssueStatus(await load(issueId), 'needs_info', person(), {
      reason: 'should the export keep the legacy column order?',
      transitionReason: 'should the export keep the legacy column order?',
      waitingKind: 'needs_answer',
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

describe('the park view exists for exactly the issues Needs you lists', () => {
  it('agrees with the search Needs you reads, row for row', async () => {
    const ids = {
      needsInfo: await insertIssue('needs_info'),
      resource: await insertIssue('needs_info', 'needs_resource'),
      marked: await insertIssue('in_progress'),
      peerOnly: await insertIssue('in_progress'),
      working: await insertIssue('in_progress'),
      held: await insertIssue('on_hold'),
    };
    await openQuestion(ids.marked);
    await openQuestion(ids.peerOnly, 'master_or_peer');
    const res = await app.request(
      `/api/projects/${projectId}/issues/search?status=needs_info&orWaitingOnPerson=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const listed = ((await res.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id);
    const viewed: string[] = [];
    for (const id of Object.values(ids)) {
      if (await parkView.loadIssuePark(id)) viewed.push(id);
    }
    expect(viewed.sort()).toEqual(listed.sort());
    expect(viewed.sort()).toEqual([ids.needsInfo, ids.resource, ids.marked].sort());
  });
});

describe('the moves the park menu sends', () => {
  it('resumes a decision park at the status it left, without asking that status’s evidence again', async () => {
    const issueId = await insertIssue('needs_info', 'needs_decision');
    await leftFrom(issueId, 'awaiting_release');
    await transition.transitionIssueStatus(await load(issueId), 'awaiting_release', person());
    expect((await rowOf(issueId)).status).toBe('awaiting_release');
  });

  it('refuses a resume at a working status the park did not leave, by name, and moves nothing', async () => {
    const issueId = await insertIssue('needs_info', 'needs_decision');
    await leftFrom(issueId, 'awaiting_release');
    await expect(
      transition.transitionIssueStatus(await load(issueId), 'approved', person()),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    expect((await rowOf(issueId)).status).toBe('needs_info');
  });

  it('posts a person’s reason for leaving a park on the thread', async () => {
    const issueId = await insertIssue('needs_info');
    await leftFrom(issueId, 'in_progress');
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
    const issueId = await insertIssue('on_hold');
    await leftFrom(issueId, 'in_progress');
    await transition.transitionIssueStatus(await load(issueId), 'needs_info', person(), {
      reason: 'needs a login, not an answer',
      transitionReason: 'needs a login, not an answer',
      waitingKind: 'needs_resource',
    });
    const posted = await bodies(issueId);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('moved from `on_hold`');
    expect(posted[0]).toContain('supply something');
    expect(posted[0]).toContain('needs a login, not an answer');
  });

  it('posts nothing for a move out of a park that carries no reason, or an agent’s', async () => {
    const quiet = await insertIssue('needs_info', 'needs_decision');
    await leftFrom(quiet, 'in_progress');
    await transition.transitionIssueStatus(await load(quiet), 'in_progress', person());
    const byAgent = await insertIssue('needs_info');
    await leftFrom(byAgent, 'in_progress');
    await transition.transitionIssueStatus(await load(byAgent), 'in_progress', agent(), {
      transitionReason: 'resuming',
    });
    expect(await bodies(quiet)).toEqual([]);
    expect(await bodies(byAgent)).toEqual([]);
  });

  it('voids the open questions and resumes in one write when the question is not needed', async () => {
    const issueId = await insertIssue('needs_info');
    await leftFrom(issueId, 'approved');
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
    await leftFrom(issueId, 'approved');
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
  it('keeps the kind and mints the question on an agent’s resource park', async () => {
    const issueId = await insertIssue('in_progress');
    await transition.transitionIssueStatus(await load(issueId), 'needs_info', agent(), {
      transitionReason: 'No Search Console login on this box.',
      waitingKind: 'needs_resource',
      needs: 'a Search Console login for the property',
    });
    expect(await rowOf(issueId)).toEqual({ status: 'needs_info', waitingKind: 'needs_resource' });
    const park = await parkView.loadIssuePark(issueId);
    expect(park?.owes).toBe('resource');
    expect(park?.openQuestionIds).toHaveLength(1);
  });

  it('refuses a park that names no kind, by name, and moves nothing', async () => {
    const issueId = await insertIssue('in_progress');
    await expect(
      transition.transitionIssueStatus(await load(issueId), 'needs_info', agent(), {
        transitionReason: 'Which tenant?',
        needs: 'the tenant slug',
      }),
    ).rejects.toMatchObject({ code: 'WAITING_KIND_REQUIRED' });
    expect(await rowOf(issueId)).toEqual({ status: 'in_progress', waitingKind: null });
  });

  it('reads a park stopped on an answer as owing information', async () => {
    const issueId = await insertIssue('in_progress');
    await transition.transitionIssueStatus(await load(issueId), 'needs_info', agent(), {
      transitionReason: 'Which tenant?',
      needs: 'the tenant slug',
      waitingKind: 'needs_answer',
    });
    expect(await rowOf(issueId)).toEqual({ status: 'needs_info', waitingKind: 'needs_answer' });
    expect((await parkView.loadIssuePark(issueId))?.owes).toBe('information');
  });

  it('clears the kind once the issue leaves the park', async () => {
    const issueId = await insertIssue('needs_info', 'needs_decision');
    await leftFrom(issueId, 'approved');
    await transition.transitionIssueStatus(await load(issueId), 'approved', person());
    expect(await rowOf(issueId)).toEqual({ status: 'approved', waitingKind: null });
  });
});
