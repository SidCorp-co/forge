/**
 * Workflow `suggestion-lifecycle` rev 2 against a real database: an agent proposes, a person
 * accepts, and the accept writes the kind's effect in the same transaction — or refuses by name and
 * writes nothing. The feedback_triage case is the one a DB CHECK (`suggestions_arc_chk`) broke with
 * a 500 while `createSuggestion` never wrote `feedback_id`; a unit test with a mocked insert could
 * not see it, so this suite runs the routes over Postgres.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
} from '../helpers/index.js';

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read at arbitrary depth
type Doc = Record<string, any>;

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let person: string;
let agent: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  server = await startTestServer();
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const bot = await createTestUser(harness.db, { kind: 'agent' });
  projectId = (await createTestProject(harness.db, owner.id)).id;
  await createTestProjectMember(harness.db, { userId: bot.id, projectId, role: 'member' });
  person = await signUserToken(owner.id);
  agent = await signUserToken(bot.id);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await harness?.cleanup();
});

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.baseUrl}/api/projects/${projectId}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Doc };
}

/** REQ-n agreed at revision 1 with criteria BC-1 and BC-2. */
async function agreedRequirement(title: string): Promise<string> {
  const created = await call(person, 'POST', '/requirements', {
    title,
    reason: 'planted',
    criteria: [{ body: 'A nurse sees the reminder' }, { body: 'A doctor sees the report' }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const key = created.body.key as string;
  for (const [path, body] of [
    [`/requirements/${key}/revisions/1/propose`, {}],
    [`/requirements/${key}/revisions/1/accept`, {}],
    [`/requirements/${key}/agree`, { revision: 1 }],
  ] as const) {
    const r = await call(person, 'POST', path, body);
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
  }
  return key;
}

async function propose(body: Doc) {
  const r = await call(agent, 'POST', '/suggestions', body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.suggestion.id as string;
}

const accept = (id: string) => call(person, 'POST', `/suggestions/${id}/accept`, {});

async function plantIssue(title: string): Promise<{ id: string; key: string }> {
  const r = await call(person, 'POST', '/issues', { title, status: 'open' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.id, key: r.body.displayId };
}

async function statusOf(id: string) {
  const rows = (await harness.db.execute(
    sql`SELECT status FROM suggestions WHERE id = ${id}`,
  )) as unknown as { status: string }[];
  return [...rows][0]?.status;
}

describe('feedback_triage: an agent proposes, a person accepts', () => {
  it('a proposal on FB-n is written (201) through both doors, and its accept writes the route', async () => {
    const fb = await call(person, 'POST', '/feedback', {
      kind: 'question',
      title: 'Where is the export?',
      screen: 'Reports',
    });
    expect(fb.status, JSON.stringify(fb.body)).toBe(201);
    const key = fb.body.feedback.key as string;
    const viaFeedback = await call(agent, 'POST', `/feedback/${key}/triage-suggestions`, {
      triage: { route: 'answer', answer: 'Reports, top right.' },
    });
    expect(viaFeedback.status, JSON.stringify(viaFeedback.body)).toBe(201);
    expect(viaFeedback.body.suggestion.target).toMatchObject({ type: 'feedback' });
    const viaSuggestions = await call(agent, 'POST', '/suggestions', {
      kind: 'feedback_triage',
      feedback: key,
      baseRevision: null,
      payload: { route: 'answer', answer: 'Reports menu, then Export.' },
    });
    expect(viaSuggestions.status, JSON.stringify(viaSuggestions.body)).toBe(201);
    const accepted = await accept(viaFeedback.body.suggestion.id);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.effect).toMatchObject({ feedback: key, route: 'answer' });
  });
});

describe('breakdown: accepting files the issues at draft, in one transaction', () => {
  it('creates each issue at draft, linked with planned_revision, criteria traced and blocks edges', async () => {
    const req = await agreedRequirement('Reminders');
    const sid = await propose({
      kind: 'breakdown',
      requirement: req,
      baseRevision: 1,
      payload: {
        issues: [
          { title: 'Reminder job', criteria: [{ body: 'Job sends at D+1', tracesTo: 'BC-1' }] },
          { title: 'Report page', criteria: [{ body: 'Page lists sends' }], blockedBy: [0] },
        ],
      },
    });
    const accepted = await accept(sid);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const filed = accepted.body.effect.issues as { issueId: string; key: string }[];
    expect(filed).toHaveLength(2);
    const rows = (await harness.db.execute(sql`
      SELECT i.id, i.status, i.planned_revision, r.req_seq,
             (SELECT rc.code FROM issue_criteria c JOIN requirement_criteria rc ON rc.id = c.requirement_criterion_id
               WHERE c.issue_id = i.id AND c.retired_at IS NULL LIMIT 1) AS traced,
             (SELECT count(*)::int FROM issue_criteria c WHERE c.issue_id = i.id AND c.retired_at IS NULL) AS criteria
        FROM issues i JOIN requirements r ON r.id = i.requirement_id
       WHERE i.id IN (${filed[0]?.issueId}, ${filed[1]?.issueId}) ORDER BY i.iss_seq`)) as unknown as Doc[];
    expect([...rows]).toEqual([
      expect.objectContaining({
        status: 'draft',
        planned_revision: 1,
        traced: 'BC-1',
        criteria: 1,
      }),
      expect.objectContaining({ status: 'draft', planned_revision: 1, traced: null, criteria: 1 }),
    ]);
    const edges = (await harness.db.execute(sql`
      SELECT from_issue_id, to_issue_id FROM issue_dependencies
       WHERE kind = 'blocks' AND to_issue_id = ${filed[1]?.issueId}`)) as unknown as Doc[];
    expect([...edges]).toEqual([
      { from_issue_id: filed[0]?.issueId, to_issue_id: filed[1]?.issueId },
    ]);
    const detail = await call(person, 'GET', `/requirements/${req}`);
    expect(detail.body.standing.waitingOn.act).not.toBe('break down');
    expect(detail.body.standing.waitingOn.act).toBe('promote 2 draft issues');
  });

  it('a criterion tracing to a BC the revision does not hold refuses the accept by name and files nothing', async () => {
    const req = await agreedRequirement('Exports');
    const sid = await propose({
      kind: 'breakdown',
      requirement: req,
      baseRevision: 1,
      payload: {
        issues: [
          { title: 'Export A' },
          { title: 'Export B', criteria: [{ body: 'x', tracesTo: 'BC-9' }] },
        ],
      },
    });
    const refused = await accept(sid);
    expect(refused.status).toBe(422);
    expect(refused.body.error.refusals).toEqual([
      expect.objectContaining({
        code: 'SUGGESTION_PAYLOAD_INVALID',
        path: '/payload/issues/1/criteria/0/tracesTo',
      }),
    ]);
    const detail = await call(person, 'GET', `/requirements/${req}`);
    expect(detail.body.issues).toEqual([]);
    expect(await statusOf(sid)).toBe('proposed');
  });
});

describe('breakdown: blocks edges that form a cycle', () => {
  it('are refused by name at the entry that closes the cycle, and nothing is filed', async () => {
    const req = await agreedRequirement('Cycle');
    const sid = await propose({
      kind: 'breakdown',
      requirement: req,
      baseRevision: 1,
      payload: {
        issues: [
          { title: 'First', blockedBy: [1] },
          { title: 'Second', blockedBy: [0] },
        ],
      },
    });
    const refused = await accept(sid);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error.refusals).toEqual([
      expect.objectContaining({
        code: 'SUGGESTION_PAYLOAD_INVALID',
        path: '/payload/issues/1/blockedBy/0',
      }),
    ]);
    expect((await call(person, 'GET', `/requirements/${req}`)).body.issues).toEqual([]);
    expect(await statusOf(sid)).toBe('proposed');
  });
});

describe('readiness, triage and duplicate: each kind writes its own effect', () => {
  it('readiness: the accepted row is the readiness result the requirement reads at its head', async () => {
    const req = await agreedRequirement('Readiness');
    const sid = await propose({
      kind: 'readiness',
      requirement: req,
      baseRevision: 1,
      payload: {
        checks: [
          { check: 'criteria testable', passed: true },
          { check: 'designs approved', passed: false },
        ],
      },
    });
    const accepted = await accept(sid);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.effect).toMatchObject({
      requirement: req,
      revision: 1,
      ready: false,
      failed: ['designs approved'],
    });
    const detail = await call(person, 'GET', `/requirements/${req}`);
    expect(detail.body.readiness).toMatchObject({ revision: 1, ready: false, suggestionId: sid });
  });

  it('triage on an issue sets its priority, category and complexity; its route becomes a note comment', async () => {
    const issue = await plantIssue('Triage me');
    const sid = await propose({
      kind: 'triage',
      issue: issue.id,
      baseRevision: null,
      payload: { priority: 'high', category: 'bug', complexity: 's', note: 'crashes on save' },
    });
    const accepted = await accept(sid);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const [row] = [
      ...((await harness.db.execute(
        sql`SELECT priority, category, complexity FROM issues WHERE id = ${issue.id}`,
      )) as unknown as Doc[]),
    ];
    expect(row).toEqual({ priority: 'high', category: 'bug', complexity: 's' });
    expect(accepted.body.effect).toMatchObject({ complexity: 's', routeCommentId: null });
    const routed = await propose({
      kind: 'triage',
      issue: issue.id,
      baseRevision: null,
      payload: { route: 'master', note: 'route it' },
    });
    const noted = await accept(routed);
    expect(noted.status, JSON.stringify(noted.body)).toBe(200);
    expect(await statusOf(routed)).toBe('accepted');
    const comments = (await harness.db.execute(
      sql`SELECT id, intent, body FROM comments WHERE issue_id = ${issue.id}`,
    )) as unknown as Doc[];
    expect([...comments]).toEqual([
      {
        id: noted.body.effect.routeCommentId,
        intent: 'note',
        body: `Triage route (suggestion ${routed}): master\n\nroute it`,
      },
    ]);
  });

  it('duplicate on an issue drops it naming the root, with a relates edge; on a requirement it is refused', async () => {
    const root = await plantIssue('Root');
    const dup = await plantIssue('Twin');
    const sid = await propose({
      kind: 'duplicate',
      issue: dup.id,
      baseRevision: null,
      payload: { duplicateOf: root.id, note: 'same crash' },
    });
    const accepted = await accept(sid);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.effect).toMatchObject({ issueId: dup.id, status: 'dropped' });
    const [issue] = [
      ...((await harness.db.execute(
        sql`SELECT status FROM issues WHERE id = ${dup.id}`,
      )) as unknown as Doc[]),
    ];
    expect(issue?.status).toBe('dropped');
    const edges = (await harness.db.execute(sql`
      SELECT kind FROM issue_dependencies WHERE from_issue_id = ${root.id} AND to_issue_id = ${dup.id}`)) as unknown as Doc[];
    expect([...edges]).toEqual([{ kind: 'relates' }]);
    expect(await statusOf(sid)).toBe('accepted');

    const req = await agreedRequirement('Dup requirement');
    const onReq = await propose({
      kind: 'duplicate',
      requirement: req,
      baseRevision: 1,
      payload: { duplicateOf: 'REQ-1' },
    });
    const refused = await accept(onReq);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('SUGGESTION_EFFECT_UNDECIDED');
  });
});

describe('a stale base on accept names both revisions', () => {
  it('a suggestion the head moved past answers SUGGESTION_BASE_STALE, not a bare SUGGESTION_DECIDED', async () => {
    const req = await agreedRequirement('Moving head');
    const sid = await propose({
      kind: 'revision_diff',
      requirement: req,
      baseRevision: 1,
      payload: { reason: 'tighten', criteria: [{ code: 'BC-1', body: 'A nurse sees it at D+1' }] },
    });
    const written = await call(person, 'POST', `/requirements/${req}/revisions`, {
      baseRevision: 1,
      reason: 'another change',
      criteria: [{ code: 'BC-1', body: 'A nurse sees the reminder today' }],
    });
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    for (const step of ['propose', 'accept']) {
      const r = await call(person, 'POST', `/requirements/${req}/revisions/2/${step}`, {});
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    expect(await statusOf(sid)).toBe('stale');
    const refused = await accept(sid);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('SUGGESTION_BASE_STALE');
    expect(refused.body.error.refusals[0].detail).toMatch(/revision 1.*revision 2/);
  });

  it('a revision an accepted suggestion carries names its producer as author and points back', async () => {
    const req = await agreedRequirement('Provenance');
    const sid = await propose({
      kind: 'revision_diff',
      requirement: req,
      baseRevision: 1,
      payload: { reason: 'agent wording', criteria: [{ code: 'BC-1', body: 'Sharper' }] },
    });
    const accepted = await accept(sid);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const detail = await call(person, 'GET', `/requirements/${req}`);
    const r2 = (detail.body.revisions as Doc[]).find((r) => r.revision === 2);
    expect(r2).toMatchObject({ authorKind: 'agent', fromSuggestionId: sid });
  });
});
