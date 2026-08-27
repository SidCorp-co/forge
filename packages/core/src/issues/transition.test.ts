import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
// ISS-64 — `triggerTerminalDispatch` reads dependents via
// `db.select(...).from(issueDependencies).innerJoin(issues, ...).where(...)`.
// The where step resolves to an array of dependent rows.
const dependentsAwait = vi.fn(
  async () =>
    [] as Array<
      | { fromIssueId: string; toIssueId: string; depProjectId: string; toIssSeq: number }
      | { issueId: string; issSeq: number; projectId: string }
    >,
);
const dependentsWhere = vi.fn(() => dependentsAwait());
const dependentsInnerJoin = vi.fn(() => ({ where: dependentsWhere }));
const selectFrom = vi.fn(() => ({
  where: selectWhere,
  innerJoin: dependentsInnerJoin,
}));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn((_values: Record<string, unknown>) => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));
// ISS-196 — `withActorContext` calls `tx.execute(SELECT set_config(...))`
// before the UPDATE. Stub `tx.execute` so it does not throw under the
// in-memory db mock.
const txExecute = vi.fn(async () => undefined);

vi.mock('../db/client.js', () => {
  const txStub = {
    select: vi.fn(() => ({ from: selectFrom })),
    update: dbUpdate,
    execute: txExecute,
  };
  return {
    db: {
      select: vi.fn(() => ({ from: selectFrom })),
      update: dbUpdate,
      // cm:why the reopen-reason comment (RFC 0002 INV-8) is a real insert on the reopen path, and postReopenReasonComment deliberately does not swallow its error — an unmocked insert therefore turns every reopen test into a 500
      insert: vi.fn(() => ({ values: async () => undefined })),
      transaction: vi.fn(async (cb: (tx: typeof txStub) => unknown) => cb(txStub)),
    },
  };
});

const publish = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: (...args: unknown[]) => publish(...args) },
}));

// ISS-40 PR-E — terminal transitions now fire-and-forget a dispatch tick.
// Stub the orchestrator so we don't drag in the dispatcher/pg-boss module
// graph (which constructs PgBoss at import time and needs DATABASE_URL).
vi.mock('../jobs/dispatch-tick.js', () => ({
  dispatchTickForProject: vi.fn(async () => {}),
}));

// Org-level authz: stub the db-touching resolver; pure helpers
// (assertProjectRole, projectRoleAtLeast) stay real.
const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const { transitionRoutes } = await import('./transition.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/issues', transitionRoutes);
  app.onError(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  // cm:guard keep a default for reads no test queues: an exhausted `mockResolvedValueOnce` returns `undefined`, which throws inside the caller's destructuring and reaches the test as a 500 — so a new read added to the route under test fails every case here with the wrong reason
  selectLimit.mockResolvedValue([]);
  updateReturning.mockReset();
  publish.mockReset();
  projectAccess.mockReset();
  dependentsAwait.mockReset();
  dependentsAwait.mockResolvedValue([]);
});

/** The literal SQL a drizzle condition would render, with its params dropped. */
function sqlText(node: unknown): string {
  if (node === null || typeof node !== 'object') return '';
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) return chunks.map(sqlText).join('');
  const value = (node as { value?: unknown }).value;
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value.join('') : '';
}

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function req(body: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return buildApp().request(`/api/issues/${ISSUE_ID}/transition`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function queueAuthAndIssue(row: {
  status: string;
  reopenCount?: number;
  verified?: boolean;
  member?: boolean;
  role?: 'admin' | 'member' | 'viewer';
  issSeq?: number;
}) {
  // 1) assertEmailVerified select
  selectLimit.mockResolvedValueOnce([
    { emailVerifiedAt: row.verified === false ? null : new Date() },
  ]);
  // 2) issue row lookup
  selectLimit.mockResolvedValueOnce([
    {
      id: ISSUE_ID,
      projectId: PROJECT_ID,
      status: row.status,
      reopenCount: row.reopenCount ?? 0,
      issSeq: row.issSeq ?? 1,
    },
  ]);
  // 3) effective project access resolution
  projectAccess.mockResolvedValueOnce({
    projectId: PROJECT_ID,
    orgId: 'org-1',
    role: row.member === false ? null : (row.role ?? 'member'),
    orgRole: null,
  });
}

describe('POST /api/issues/:id/transition', () => {
  it('401 without bearer token', async () => {
    const res = await req({ toStatus: 'confirmed' });
    expect(res.status).toBe(401);
  });

  it('404 when issue does not exist', async () => {
    const token = await signUserToken(USER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    selectLimit.mockResolvedValueOnce([]);
    const res = await req({ toStatus: 'confirmed' }, token);
    expect(res.status).toBe(404);
  });

  it('403 when user is not a project member', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'open', member: false });
    const res = await req({ toStatus: 'confirmed' }, token);
    expect(res.status).toBe(403);
  });

  it('400 on unknown body field (strict)', async () => {
    const token = await signUserToken(USER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    const res = await req({ toStatus: 'confirmed', bogus: 1 }, token);
    expect(res.status).toBe(400);
  });

  it('400 on invalid toStatus', async () => {
    const token = await signUserToken(USER_ID);
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    const res = await req({ toStatus: 'nonsense' }, token);
    expect(res.status).toBe(400);
  });

  it('409 NO_OP when toStatus equals current status', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'open' });
    const res = await req({ toStatus: 'open' }, token);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NO_OP');
  });

  // cm:guard the three cap tests deleted from this spot asserted a 422 at reopenCount>=5 and an admin-only override. RFC 0002 removed the cap outright — reopenCount still increments (ISS-535 model escalation reads it), it just gates nothing. A returning 422 here means someone re-added the ceiling.
  // cm:guard all three stopping statuses, not just reopen — `waiting` and `needs_info` mean "a human is needed", and one that does not say WHAT is needed is a question nobody can answer; on forge-beta 2026-08-14 all 43 issues at `waiting` were exactly that
  it.each([
    ['reopen', 'closed'],
    ['waiting', 'in_progress'],
    ['needs_info', 'open'],
  ])('422 TRANSITION_REASON_REQUIRED entering %s with no reason', async (to, from) => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: from, reopenCount: 0 });
    const res = await req({ toStatus: to }, token);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('TRANSITION_REASON_REQUIRED');
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  // cm:guard the kind is REQUIRED but must never be DEFAULTED — this test fails both ways: drop the requirement and it 200s, add a default and it 200s. Guessing the kind is what rendered the wrong button on ISS-163.
  it('422 WAITING_KIND_REQUIRED when a `waiting` park states a reason but no kind', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'in_progress', reopenCount: 0 });
    const res = await req({ toStatus: 'waiting', reason: 'need the staging DB password' }, token);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('WAITING_KIND_REQUIRED');
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it('200 when a `waiting` park carries both a reason and a kind', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'in_progress', reopenCount: 0 });
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, status: 'waiting', reopenCount: 0, updatedAt: new Date() },
    ]);
    const res = await req(
      {
        toStatus: 'waiting',
        reason: 'need the staging DB password',
        waitingKind: 'needs_resource',
      },
      token,
    );
    expect(res.status).toBe(200);
  });

  it('200 closed → reopen with a reason increments reopen_count, at any count', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'closed', reopenCount: 9 });
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, status: 'reopen', reopenCount: 10, updatedAt: new Date() },
    ]);
    const res = await req({ toStatus: 'reopen', reason: 'the 500 is back on prod' }, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reopenCount: number };
    expect(body.reopenCount).toBe(10);
  });

  it('200 non-reopen transition does not touch reopen_count', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'reopen', reopenCount: 2 });
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, status: 'developed', reopenCount: 2, updatedAt: new Date() },
    ]);
    const res = await req({ toStatus: 'developed', reason: 'fix pushed' }, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reopenCount: number };
    expect(body.reopenCount).toBe(2);
    expect(publish).toHaveBeenCalledOnce();
    const [room, envelope] = publish.mock.calls[0] as [string, { event: string; data: unknown }];
    expect(room).toBe(`project:${PROJECT_ID}`);
    expect(envelope.event).toBe('issue.statusChanged');
  });

  it('terminal transition with outgoing blocks edges publishes issue.unblockCascade', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'tested', issSeq: 7 });
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, status: 'released', reopenCount: 0, updatedAt: new Date() },
    ]);
    dependentsAwait.mockResolvedValueOnce([
      {
        fromIssueId: ISSUE_ID,
        toIssueId: '44444444-4444-4444-8444-444444444444',
        depProjectId: PROJECT_ID,
        toIssSeq: 12,
      },
    ]);
    const res = await req({ toStatus: 'released' }, token);
    expect(res.status).toBe(200);
    const cascadeCalls = publish.mock.calls.filter(
      (c) => (c[1] as { event: string }).event === 'issue.unblockCascade',
    );
    expect(cascadeCalls).toHaveLength(1);
    const [room, envelope] = cascadeCalls[0] as [
      string,
      { event: string; data: Record<string, unknown> },
    ];
    expect(room).toBe(`project:${PROJECT_ID}`);
    expect(envelope.data).toMatchObject({
      blockerId: ISSUE_ID,
      blockerIssSeq: 7,
      overflow: 0,
      dependents: [{ issueId: '44444444-4444-4444-8444-444444444444', issSeq: 12 }],
    });
  });

  it('terminal transition with NO outgoing blocks edges does not publish cascade', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'tested' });
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, status: 'released', reopenCount: 0, updatedAt: new Date() },
    ]);
    dependentsAwait.mockResolvedValueOnce([]);
    const res = await req({ toStatus: 'released' }, token);
    expect(res.status).toBe(200);
    const cascadeCalls = publish.mock.calls.filter(
      (c) => (c[1] as { event: string }).event === 'issue.unblockCascade',
    );
    expect(cascadeCalls).toHaveLength(0);
  });

  // ISS-236 — draft is a pre-pipeline lane for AI-generated proposals.
  it('200 draft → open promotes the proposal and publishes statusChanged', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'draft' });
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, status: 'open', reopenCount: 0, updatedAt: new Date() },
    ]);
    const res = await req({ toStatus: 'open' }, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('open');
    expect(publish).toHaveBeenCalledOnce();
    const [, envelope] = publish.mock.calls[0] as [string, { event: string }];
    expect(envelope.event).toBe('issue.statusChanged');
  });

  it('200 draft → closed discards the proposal', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'draft' });
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, status: 'closed', reopenCount: 0, updatedAt: new Date() },
    ]);
    const res = await req({ toStatus: 'closed', reason: 'draft discarded' }, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('closed');
  });

  it('409 ILLEGAL_TRANSITION when draft attempts to skip into the pipeline', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'draft' });
    const res = await req({ toStatus: 'in_progress' }, token);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ILLEGAL_TRANSITION');
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it('409 STALE_TRANSITION when conditional UPDATE finds no matching row', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'open' });
    updateReturning.mockResolvedValueOnce([]); // concurrent writer won
    const res = await req({ toStatus: 'confirmed' }, token);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('STALE_TRANSITION');
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('POST /api/issues/:id/transition — dropping a blocker', () => {
  it('a drop announces the dependents it released, though the edges are already expired', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'open', issSeq: 7 });
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, status: 'dropped', reopenCount: 0, updatedAt: new Date() },
    ]);
    dependentsAwait.mockResolvedValueOnce([
      { issueId: '44444444-4444-4444-8444-444444444444', issSeq: 12, projectId: PROJECT_ID },
    ]);

    const res = await req({ toStatus: 'dropped' }, token);
    expect(res.status).toBe(200);
    // cm:guard exactly ONE read. A second would run after the expiry, and every dependent query filters `valid_until > now()`, so it would return nothing and this cascade would be silent — the whole reason the list is carried instead of re-derived.
    expect(dependentsAwait).toHaveBeenCalledTimes(1);

    const expiry = updateSet.mock.calls.find(
      (c) => (c[0] as Record<string, unknown> | undefined)?.validUntil !== undefined,
    );
    expect(expiry).toBeDefined();

    const cascade = publish.mock.calls.filter(
      (c) => (c[1] as { event: string }).event === 'issue.unblockCascade',
    );
    expect(cascade).toHaveLength(1);
    expect((cascade[0] as [string, { data: Record<string, unknown> }])[1].data).toMatchObject({
      blockerId: ISSUE_ID,
      blockerIssSeq: 7,
      dependents: [{ issueId: '44444444-4444-4444-8444-444444444444', issSeq: 12 }],
    });
  });
});

describe('POST /api/issues/:id/transition — draft as a target (ISS-787)', () => {
  it('409 ILLEGAL_TRANSITION naming the run/job counts when draft would demote real work', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'open' });
    selectLimit.mockResolvedValueOnce([{ n: 2 }]);
    selectLimit.mockResolvedValueOnce([{ n: 7 }]);
    const res = await req({ toStatus: 'draft' }, token);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('ILLEGAL_TRANSITION');
    expect(body.message).toContain('2 pipeline run(s)');
    expect(body.message).toContain('7 job(s)');
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it('allows draft while the issue has never entered the pipeline (ISS-787)', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'open' });
    selectLimit.mockResolvedValueOnce([{ n: 0 }]);
    selectLimit.mockResolvedValueOnce([{ n: 0 }]);
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, status: 'draft', reopenCount: 0, updatedAt: new Date() },
    ]);
    const res = await req({ toStatus: 'draft' }, token);
    expect(res.status).toBe(200);
    expect(
      updateSet.mock.calls.some(([values]) => (values as { status?: string }).status === 'draft'),
    ).toBe(true);
  });

  it('blames the status race, not a phantom run, when the conditional UPDATE loses', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'open' });
    selectLimit.mockResolvedValueOnce([{ n: 0 }]);
    selectLimit.mockResolvedValueOnce([{ n: 0 }]);
    updateReturning.mockResolvedValueOnce([]);
    selectLimit.mockResolvedValueOnce([{ status: 'confirmed' }]);
    selectLimit.mockResolvedValueOnce([{ n: 0 }]);
    selectLimit.mockResolvedValueOnce([{ n: 0 }]);

    const res = await req({ toStatus: 'draft' }, token);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('STALE_TRANSITION');
    expect(body.message).toContain('confirmed');
    expect(body.message).not.toMatch(/run or job appeared/i);
  });

  it('refuses draft when the run/job check itself fails — fails CLOSED', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'open' });
    selectLimit.mockRejectedValueOnce(new Error('connection reset'));
    selectLimit.mockRejectedValueOnce(new Error('connection reset'));
    const res = await req({ toStatus: 'draft' }, token);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('ILLEGAL_TRANSITION');
    expect(body.message).toMatch(/could not be checked/i);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  // cm:guard assert the never-ran predicate is IN the UPDATE's WHERE, not merely that the pre-check ran — the pre-check and the UPDATE are separate reads, so with the WHERE arm gone every draft test still passes while a freshly-`open` issue that acquires its run between them is demoted to a status claiming nothing started. This is hand-written raw SQL no type-checker covers.
  it('carries the never-ran predicate INTO the UPDATE, not just the pre-check', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'open' });
    selectLimit.mockResolvedValueOnce([{ n: 0 }]);
    selectLimit.mockResolvedValueOnce([{ n: 0 }]);
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, status: 'draft', reopenCount: 0, updatedAt: new Date() },
    ]);

    expect((await req({ toStatus: 'draft' }, token)).status).toBe(200);
    const where = sqlText((updateWhere.mock.calls[0] as unknown[])?.[0]);
    // cm:guard match the CORRELATION columns too, not just `not exists` — writing `pr.id` in place of `pr.issue_id` keeps every coarse substring, stays green, and makes both subqueries permanently non-empty so the gate blocks nothing. sqlText erases operands, so a column is only visible as the raw template text it is.
    expect(where).toContain('not exists (select 1 from pipeline_runs pr where pr.issue_id = )');
    expect(where).toContain('not exists (select 1 from jobs j where j.issue_id = )');
  });

  it('leaves the never-ran predicate off a transition that is not to draft', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'open' });
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, status: 'confirmed', reopenCount: 0, updatedAt: new Date() },
    ]);

    expect((await req({ toStatus: 'confirmed' }, token)).status).toBe(200);
    expect(sqlText((updateWhere.mock.calls[0] as unknown[])?.[0])).not.toContain('not exists');
  });
});
