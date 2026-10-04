// REQ-2 BC-10 at the REST door (workflow `issue-lifecycle` rev 3): the recovery move hands an
// `in_progress` issue nothing holds back to `reopen`, never displaces a holder, and reaches no other move.

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let mintPat: typeof import('../../src/auth/pat.js')['mintPat'];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.NODE_ENV ??= 'test';

  const [transitionMod, routesMod, criteriaMod, patMod, errMod] = await Promise.all([
    import('../../src/issues/transition.js'),
    import('../../src/issues/routes.js'),
    import('../../src/issues/criteria/routes.js'),
    import('../../src/auth/pat.js'),
    import('../../src/middleware/error.js'),
  ]);
  mintPat = patMod.mintPat;
  app = new Hono();
  app.route('/api/issues', routesMod.issueRoutes);
  app.route('/api/issues', transitionMod.transitionRoutes);
  app.route('/api/issues', criteriaMod.issueCriteriaRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

const PASSING_SHA = '33637c612ef15be6f924520c0d201a0889d8ed7e';

interface World {
  projectId: string;
  humanId: string;
  human: string;
  agent: string;
}

async function world(): Promise<World> {
  const human = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const agent = await createTestUser(harness.db, { kind: 'agent' });
  const project = await createTestProject(harness.db, human.id);
  await createTestProjectMember(harness.db, { userId: agent.id, projectId: project.id });
  const h = await mintPat({ userId: human.id, name: 'person', boundProjectId: project.id });
  const a = await mintPat({ userId: agent.id, name: 'agent', boundProjectId: project.id });
  return { projectId: project.id, humanId: human.id, human: h.plaintext, agent: a.plaintext };
}

async function insertIssue(
  w: World,
  status: string,
  extra: { plan?: string; criteria?: string; mergedAt?: boolean; waitingKind?: string } = {},
): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id, status, plan,
                        merged_at, waiting_kind)
    VALUES (${w.projectId}::uuid, 'an issue', ${w.humanId}::uuid, ${status},
            ${extra.plan ?? null},
            ${extra.mergedAt ? sql`now()` : sql`NULL`}, ${extra.waitingKind ?? null})
    RETURNING id
  `);
  const id = (rows[0] as { id: string }).id;
  if (extra.criteria) {
    const criteria = extra.criteria.split('\n').map((line) => {
      const [, n, statement] = /^(\d+)\. (.+)$/.exec(line) ?? [];
      return { n: Number(n), statement: statement as string };
    });
    const res = await call('PUT', `/api/issues/${id}/criteria`, w.human, { criteria });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return id;
}

/** A live lease on the issue's work state: what a claim leaves behind. */
async function holdLease(issueId: string): Promise<void> {
  const lease = { holder: 'run-iss54', renewedAt: new Date().toISOString(), minutes: 30 };
  await harness.db.execute(sql`
    INSERT INTO issue_work_state (issue_id, lease) VALUES (${issueId}, ${JSON.stringify(lease)}::jsonb)
    ON CONFLICT (issue_id) DO UPDATE SET lease = EXCLUDED.lease
  `);
}

async function call(
  method: string,
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'X-Forge-Lifecycle': '10',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// One verdict per entry through the REST writer; `identity: false` plants the only identity-less
// pass the gate can meet, a backfilled `commit_unresolved` abbreviation no writer can name.
async function postVerdicts(
  w: World,
  issueId: string,
  verdicts: Array<{ criterion: number; verdict: string; identity?: boolean }>,
): Promise<void> {
  for (const v of verdicts) {
    if (v.identity === false) {
      await harness.db.execute(sql`
        INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, identity_kind, commit_sha,
                                        author_agency, backfilled)
        SELECT id, issue_id, ${v.verdict}, 'commit_unresolved', '1810f84', 'agent', true
          FROM issue_criteria
         WHERE issue_id = ${issueId} AND n = ${v.criterion} AND retired_at IS NULL
      `);
      continue;
    }
    const res = await call('POST', `/api/issues/${issueId}/verdicts`, w.agent, {
      criterion: v.criterion,
      verdict: v.verdict,
      identity: { kind: 'commit', sha: PASSING_SHA },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
}

const move = (issueId: string, token: string, body: Record<string, unknown>) =>
  call('POST', `/api/issues/${issueId}/transition`, token, body);

async function statusOf(issueId: string): Promise<{ status: string; waitingKind: string | null }> {
  const rows = (await harness.db.execute(sql`
    SELECT status, waiting_kind FROM issues WHERE id = ${issueId}
  `)) as unknown as Array<{ status: string; waiting_kind: string | null }>;
  const row = rows[0] as { status: string; waiting_kind: string | null };
  return { status: row.status, waitingKind: row.waiting_kind };
}

function expectRefused(
  res: { status: number; body: Record<string, unknown> },
  http: number,
  code: string,
) {
  expect(res.body.code, JSON.stringify(res.body)).toBe(code);
  expect(res.status).toBe(http);
}

describe('the recovery move: an in_progress issue nothing holds is handed back (REQ-2 BC-10)', () => {
  it('a judge that failed a criterion and let go hands the issue back to reopen with its reason', async () => {
    const w = await world();
    const id = await insertIssue(w, 'in_progress', { criteria: '1. one\n2. two' });
    await postVerdicts(w, id, [
      { criterion: 1, verdict: 'pass' },
      { criterion: 2, verdict: 'fail' },
    ]);
    const res = await move(id, w.human, {
      toStatus: 'reopen',
      recovery: true,
      reason: 'judge failed criterion 2',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('reopen');
    expect(res.body.reopenCount).toBe(1);
    await holdLease(id);
    expect((await move(id, w.agent, { toStatus: 'in_progress' })).status).toBe(200);
    await postVerdicts(w, id, [{ criterion: 2, verdict: 'pass' }]);
    const stale = await move(id, w.agent, { toStatus: 'awaiting_release' });
    expectRefused(stale, 409, 'VERDICT_PREDATES_REOPEN');
    expect((stale.body.details as { predateReopen: number[] }).predateReopen).toEqual([1]);
    await postVerdicts(w, id, [{ criterion: 1, verdict: 'pass' }]);
    expect((await move(id, w.agent, { toStatus: 'awaiting_release' })).status).toBe(200);
  });

  it('without recovery the move is off the lifecycle, and the refusal names the recovery move', async () => {
    const w = await world();
    const id = await insertIssue(w, 'in_progress');
    const res = await move(id, w.human, { toStatus: 'reopen', reason: 'judge failed' });
    expectRefused(res, 409, 'ILLEGAL_TRANSITION');
    expect(String(res.body.message)).toContain('`recovery: true`');
    expect((await statusOf(id)).status).toBe('in_progress');
  });

  it('never displaces a live holder', async () => {
    const w = await world();
    const id = await insertIssue(w, 'in_progress');
    await holdLease(id);
    const res = await move(id, w.human, { toStatus: 'reopen', recovery: true, reason: 'r' });
    expectRefused(res, 409, 'ILLEGAL_TRANSITION');
    expect(String(res.body.message)).toContain('holds this one');
    expect((await statusOf(id)).status).toBe('in_progress');
  });

  it('still needs the reason reopen needs', async () => {
    const w = await world();
    const id = await insertIssue(w, 'in_progress');
    expectRefused(
      await move(id, w.human, { toStatus: 'reopen', recovery: true }),
      422,
      'TRANSITION_REASON_REQUIRED',
    );
  });

  it('reaches no move but the hand-back of in_progress', async () => {
    const w = await world();
    const id = await insertIssue(w, 'draft');
    const res = await move(id, w.human, { toStatus: 'reopen', recovery: true, reason: 'r' });
    expectRefused(res, 409, 'ILLEGAL_TRANSITION');
    expect(String(res.body.message)).toContain('is not one');
    expect((await statusOf(id)).status).toBe('draft');
  });
});
