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
    [] as Array<{
      fromIssueId: string;
      toIssueId: string;
      depProjectId: string;
      toIssSeq: number;
    }>,
);
const dependentsWhere = vi.fn(() => dependentsAwait());
const dependentsInnerJoin = vi.fn(() => ({ where: dependentsWhere }));
const selectFrom = vi.fn(() => ({
  where: selectWhere,
  innerJoin: dependentsInnerJoin,
}));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
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
  updateReturning.mockReset();
  publish.mockReset();
  projectAccess.mockReset();
  dependentsAwait.mockReset();
  dependentsAwait.mockResolvedValue([]);
});

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

  it('409 ILLEGAL_TRANSITION when target is draft (never a runtime target)', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'open' });
    const res = await req({ toStatus: 'draft' }, token);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ILLEGAL_TRANSITION');
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it('422 REOPEN_CAP_EXCEEDED at 5 without override', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'closed', reopenCount: 5 });
    const res = await req({ toStatus: 'reopen' }, token);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; details: { max: number } };
    expect(body.code).toBe('REOPEN_CAP_EXCEEDED');
    expect(body.details.max).toBe(5);
  });

  it('403 OVERRIDE_DENIED when non-admin requests override', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'closed', reopenCount: 5, role: 'member' });
    const res = await req({ toStatus: 'reopen', override: true }, token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('OVERRIDE_DENIED');
  });

  it('200 when project admin overrides the reopen cap', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'closed', reopenCount: 5, role: 'admin' });
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, status: 'reopen', reopenCount: 6, updatedAt: new Date() },
    ]);
    const res = await req({ toStatus: 'reopen', override: true }, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; reopenCount: number };
    expect(body.status).toBe('reopen');
    expect(body.reopenCount).toBe(6);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('200 closed → reopen increments reopen_count', async () => {
    const token = await signUserToken(USER_ID);
    queueAuthAndIssue({ status: 'closed', reopenCount: 0 });
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, status: 'reopen', reopenCount: 1, updatedAt: new Date() },
    ]);
    const res = await req({ toStatus: 'reopen' }, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reopenCount: number };
    expect(body.reopenCount).toBe(1);
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
