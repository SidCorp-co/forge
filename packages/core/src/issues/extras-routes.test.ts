import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectOrderByLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectOrderByLimit }));
const selectInnerJoinWhere = vi.fn(() => ({ orderBy: selectOrderBy, limit: selectLimit }));
const selectInnerJoin = vi.fn(() => ({ where: selectInnerJoinWhere }));
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere, innerJoin: selectInnerJoin }));
const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));

const txUpdateWhere = vi.fn(async () => undefined);
const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));
const txUpdate = vi.fn(() => ({ set: txUpdateSet }));
const txInsertValues = vi.fn(async () => undefined);
const txInsert = vi.fn(() => ({ values: txInsertValues }));
// cm:why the advisory-lock call is stubbed to a noop; nothing here exercises the serialisation, only the response shape.
const txExecute = vi.fn(async () => undefined);
const txProxy = { update: txUpdate, insert: txInsert, execute: txExecute };
const transactionMock = vi.fn(async (cb: (tx: typeof txProxy) => Promise<unknown>) => cb(txProxy));

const dbExecute = vi.fn(async () => []);
vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    execute: (...a: unknown[]) => dbExecute(...(a as [])),
    transaction: (cb: (tx: typeof txProxy) => Promise<unknown>) => transactionMock(cb),
  },
}));

const wakeMastersForProject = vi.fn(async () => 1);
vi.mock('../ws/master-wake.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ws/master-wake.js')>()),
  wakeMastersForProject: (...a: unknown[]) => wakeMastersForProject(...(a as [])),
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const enqueueJobMock = vi.fn();
vi.mock('../jobs/enqueue.js', () => ({
  enqueueJob: (...args: unknown[]) => enqueueJobMock(...args),
}));

// cm:why the real `ws/server.js` reaches pg-boss through heartbeat-ws, which throws at import without DATABASE_URL — extras-routes reaches it transitively via `./transition.js`, so the stub is what lets this suite stay hermetic
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

// cm:why the run-lifecycle helpers are stubbed so the enrich/pipeline-step routes do not need the extra `pipeline_runs` SELECT/INSERT modelled in the db mock (ISS-101).

vi.mock('../pipeline/runs.js', () => ({
  openIssueRun: vi.fn(async () => ({ id: 'run-1', startedAt: new Date() })),
  openOneShotRun: vi.fn(async () => ({ id: 'run-1' })),
  closeRun: vi.fn(async () => undefined),
  closeRunIfOneShot: vi.fn(async () => undefined),
  closeOpenRunForIssue: vi.fn(async () => undefined),
  setCurrentStep: vi.fn(async () => undefined),
  setCurrentStepForOpenIssueRun: vi.fn(async () => undefined),
}));

const { issueExtrasRoutes } = await import('./extras-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/issues', issueExtrasRoutes);
  app.onError(errorHandler);
  return app;
}

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  // mockReset wipes the default impl; restore an empty-row default so
  // unmocked SELECT chains (eg. loadIssueSnapshot at orchestrator dispatch
  // time) return [] instead of undefined and TypeError-destructuring.
  selectLimit.mockImplementation(() => Promise.resolve([] as unknown[]));
  selectOrderByLimit.mockReset();
  projectAccess.mockReset();
  enqueueJobMock.mockReset();
  insertReturning.mockReset();
  txUpdate.mockClear();
  txUpdateSet.mockClear();
  txUpdateWhere.mockClear();
  txInsert.mockClear();
  txInsertValues.mockClear();
  transactionMock.mockClear();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('POST /api/issues/:id/enrich', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/enrich`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('404 when issue missing', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/enrich`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
  });

  it('403 when not a project member', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: null,
      orgRole: null,
    });
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/enrich`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });

  it('202 enqueues custom job and returns ids', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'member',
      orgRole: null,
    });
    insertReturning.mockResolvedValueOnce([{ id: JOB_ID, status: 'queued' }]);
    enqueueJobMock.mockResolvedValueOnce(undefined);

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/enrich`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { issueId: string; jobId: string; status: string };
    expect(body).toEqual({ issueId: ISSUE_ID, jobId: JOB_ID, status: 'queued' });
    expect(enqueueJobMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_ID }));
  });
});

describe('POST /api/issues/:id/run-pipeline-step', () => {
  // cm:guard the three selectLimit mocks below are POSITIONAL and must stay in this order — verified email, the issue row, then loadPipelineConfig's project row. A test that queues them in another order still passes its own assertion while exercising a different code path.
  function setupHappyPath(opts: { status?: string; agentConfig?: unknown } = {}) {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: ISSUE_ID, projectId: PROJECT_ID, status: opts.status ?? 'open' },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'member',
      orgRole: null,
    });
    selectLimit.mockResolvedValueOnce([{ agentConfig: opts.agentConfig ?? {}, ownerId: USER_ID }]);
    selectLimit.mockResolvedValueOnce([]);
    insertReturning.mockResolvedValueOnce([{ id: JOB_ID }]);
    enqueueJobMock.mockResolvedValueOnce(undefined);
  }

  async function post(body = '{}') {
    return buildApp().request(`/api/issues/${ISSUE_ID}/run-pipeline-step`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body,
    });
  }

  // cm:guard `released` and no `jobId`, because since ISS-933 core mints nothing for an autonomous issue. Answering `queued` with a fabricated id would tell the UI work started that no box has yet decided to take.
  it('202 releases the issue at the entry status, minting no job', async () => {
    setupHappyPath({ status: 'open' });

    const res = await post();

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ issueId: ISSUE_ID, status: 'awaiting_release' });
    expect(enqueueJobMock).not.toHaveBeenCalled();
    expect(wakeMastersForProject).toHaveBeenCalledTimes(1);
  });

  // cm:guard this endpoint is the one exit from an entry stage set to `mode: 'manual'` — the gate means "a human decides", and this IS the human. It must NOT start honouring the gate.
  it('202 even when the entry stage is gated to a human', async () => {
    setupHappyPath({
      status: 'open',
      agentConfig: { pipelineConfig: { states: { open: { mode: 'manual' } } } },
    });

    const res = await post();

    expect(res.status).toBe(202);
  });

  // cm:guard a `stage` in the body is REFUSED, not ignored. It named a rung of the staged ladder; accepting it silently would 202 a request the server did not honour, which is worse than the 400.
  it('400 on a body that still names a staged stage', async () => {
    authVerified();

    const res = await post(JSON.stringify({ stage: 'review' }));

    expect(res.status).toBe(400);
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  it('409 when the issue is not at the entry status', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'in_progress' },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'member',
      orgRole: null,
    });
    selectLimit.mockResolvedValueOnce([{ agentConfig: {}, ownerId: USER_ID }]);

    const res = await post();

    expect(res.status).toBe(409);
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/issues/pipeline-timing', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(`/api/issues/pipeline-timing?projectId=${PROJECT_ID}`);
    expect(res.status).toBe(401);
  });

  it('400 when projectId is missing', async () => {
    authVerified();
    const res = await buildApp().request('/api/issues/pipeline-timing', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });

  it('403 when not a project member', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: null,
      orgRole: null,
    });
    const res = await buildApp().request(`/api/issues/pipeline-timing?projectId=${PROJECT_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });

  it('aggregates dwell time from status-change activities', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'member',
      orgRole: null,
    });

    const issueA = '55555555-5555-4555-8555-555555555555';
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-01T01:00:00Z'); // +1h
    const t2 = new Date('2026-01-01T03:00:00Z'); // +2h

    selectOrderByLimit.mockResolvedValueOnce([
      { issueId: issueA, payload: { from: 'open', to: 'confirmed' }, createdAt: t0 },
      { issueId: issueA, payload: { from: 'confirmed', to: 'approved' }, createdAt: t1 },
      { issueId: issueA, payload: { from: 'approved', to: 'in_progress' }, createdAt: t2 },
    ]);

    const res = await buildApp().request(`/api/issues/pipeline-timing?projectId=${PROJECT_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projectId: string;
      stats: Array<{ status: string; sampleCount: number; avgMs: number }>;
    };
    expect(body.projectId).toBe(PROJECT_ID);
    const byStatus = Object.fromEntries(body.stats.map((s) => [s.status, s]));
    // 'open' dwelt for t1-t0 = 1h; 'confirmed' dwelt for t2-t1 = 2h.
    // 'approved' has no successor in the window so is not counted.
    expect(byStatus.open?.avgMs).toBe(60 * 60 * 1000);
    expect(byStatus.confirmed?.avgMs).toBe(2 * 60 * 60 * 1000);
    expect(byStatus.approved).toBeUndefined();
  });
});
