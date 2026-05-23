import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectOrderByLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectOrderByLimit }));
const selectInnerJoinWhere = vi.fn(() => ({ orderBy: selectOrderBy }));
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
const txProxy = { update: txUpdate, insert: txInsert };
const transactionMock = vi.fn(async (cb: (tx: typeof txProxy) => Promise<unknown>) => cb(txProxy));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    transaction: (cb: (tx: typeof txProxy) => Promise<unknown>) => transactionMock(cb),
  },
}));

const projectAccess = vi.fn();
vi.mock('../lib/project-access.js', () => ({
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const enqueueJobMock = vi.fn();
vi.mock('../jobs/enqueue.js', () => ({
  enqueueJob: (...args: unknown[]) => enqueueJobMock(...args),
}));

// Stub the WS server — extras-routes.ts imports helpers from
// './transition.js' (publishIssueStatusChange / triggerTerminalDispatch)
// which in turn touches `roomManager`. The real module pulls in pg-boss via
// heartbeat-ws → dispatch-tick → dispatcher, which fails to load without
// DATABASE_URL in the test env.
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

// transition.ts imports `dispatchTickForProject` directly, which transitively
// loads `queue/boss.ts` (pg-boss init). Mock the leaf so the module graph
// initialises without a DATABASE_URL.
const dispatchTick = vi.fn();
vi.mock('../jobs/dispatch-tick.js', () => ({
  dispatchTickForProject: (...args: unknown[]) => dispatchTick(...args),
}));

// ISS-108 — stub the skill resolver so the manual-trigger test doesn't need
// to model the skill_registrations JOIN skills SELECT. Each call returns a
// canonical `forge-<type>` registration for the resolved status, matching the
// pre-ISS-108 behavior of the test.
vi.mock('../pipeline/skill-mapping.js', async () => {
  const actual = await vi.importActual<typeof import('../pipeline/skill-mapping.js')>(
    '../pipeline/skill-mapping.js',
  );
  return {
    ...actual,
    createProjectSkillResolver: () => ({
      resolve: async (status: string) => {
        const m = actual.STATUS_TO_JOB_TYPE[status as keyof typeof actual.STATUS_TO_JOB_TYPE];
        if (!m) return null;
        return { type: m.type, toggle: m.toggle, skillName: `forge-${m.type}` };
      },
    }),
  };
});

// ISS-101 — stub run lifecycle helpers so enrich/pipeline-step routes don't
// need to model the extra pipeline_runs SELECT/INSERT in the db mock.
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
  dispatchTick.mockClear();
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
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: 'other', role: null });
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
      ownerId: USER_ID,
      role: 'member',
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
    expect(enqueueJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID }),
    );
  });
});

describe('POST /api/issues/:id/run-pipeline-step', () => {
  // Sequence of selectLimit calls per request:
  //   1. emailVerifiedAt lookup (authVerified)
  //   2. issue { id, projectId, status }
  //   3. loadPipelineConfig — projects { agentConfig, ownerId }
  //   4. findActiveJob — jobs { id } or empty for no-conflict
  function setupHappyPath(opts: { status?: string } = {}) {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: ISSUE_ID, projectId: PROJECT_ID, status: opts.status ?? 'confirmed' },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'member',
    });
    selectLimit.mockResolvedValueOnce([{ agentConfig: null, ownerId: USER_ID }]);
    selectLimit.mockResolvedValueOnce([]); // findActiveJob → no conflict
    insertReturning.mockResolvedValueOnce([{ id: JOB_ID }]);
    enqueueJobMock.mockResolvedValueOnce(undefined);
  }

  it('202 default-stage from issue status (confirmed → plan)', async () => {
    setupHappyPath({ status: 'confirmed' });

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/run-pipeline-step`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      issueId: string;
      jobId: string;
      stage: string;
      status: string;
    };
    expect(body).toEqual({
      issueId: ISSUE_ID,
      jobId: JOB_ID,
      stage: 'plan',
      status: 'queued',
    });
    expect(enqueueJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID }),
    );
  });

  it('202 explicit stage override', async () => {
    // Issue is at `approved` (mapped to code) but caller forces `review`.
    setupHappyPath({ status: 'approved' });

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/run-pipeline-step`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ stage: 'review' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { stage: string };
    expect(body.stage).toBe('review');
  });

  it('409 when an active job already exists for the same (issueId, type)', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'confirmed' },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'member',
    });
    selectLimit.mockResolvedValueOnce([{ agentConfig: null, ownerId: USER_ID }]);
    selectLimit.mockResolvedValueOnce([{ id: 'existing-job-id' }]); // findActiveJob hit

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/run-pipeline-step`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(409);
    expect(insertReturning).not.toHaveBeenCalled();
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  it('400 when issue status has no skill mapping and no explicit stage', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: ISSUE_ID, projectId: PROJECT_ID, status: 'on_hold' },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'member',
    });
    // No projects/jobs select mocks — the resolveSkillForStatus check throws
    // before triggerPipelineStepManual reaches loadPipelineConfig.

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/run-pipeline-step`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/issues/pipeline-timing', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(
      `/api/issues/pipeline-timing?projectId=${PROJECT_ID}`,
    );
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
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: 'other', role: null });
    const res = await buildApp().request(
      `/api/issues/pipeline-timing?projectId=${PROJECT_ID}`,
      { headers: { authorization: `Bearer ${await token()}` } },
    );
    expect(res.status).toBe(403);
  });

  it('aggregates dwell time from status-change activities', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'member',
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

    const res = await buildApp().request(
      `/api/issues/pipeline-timing?projectId=${PROJECT_ID}`,
      { headers: { authorization: `Bearer ${await token()}` } },
    );
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

describe('PATCH /api/issues/:id/manual-hold', () => {
  const url = `/api/issues/${ISSUE_ID}/manual-hold`;
  const headers = async () => ({
    authorization: `Bearer ${await token()}`,
    'content-type': 'application/json',
  });

  it('401 without token', async () => {
    const res = await buildApp().request(url, {
      method: 'PATCH',
      body: JSON.stringify({ value: true }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });

  it('400 when body is missing/invalid', async () => {
    authVerified();
    const res = await buildApp().request(url, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('404 when issue is missing', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([]); // issue lookup empty
    const res = await buildApp().request(url, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ value: true }),
    });
    expect(res.status).toBe(404);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('403 when not a project member', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: ISSUE_ID, projectId: PROJECT_ID, manualHold: false },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: 'other', role: null });
    const res = await buildApp().request(url, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ value: true }),
    });
    expect(res.status).toBe(403);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('200 toggles on, writes activity log, returns new state', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: ISSUE_ID, projectId: PROJECT_ID, manualHold: false },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'member',
    });

    const res = await buildApp().request(url, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ value: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issueId: ISSUE_ID, manualHold: true });
    // Transactional write + activity log entry both ran.
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(txUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ manualHold: true }),
    );
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'issue.manualHold.set' }),
    );
    // ISS-133 — setting hold must NOT tick (pointless work).
    expect(dispatchTick).not.toHaveBeenCalled();
  });

  it('200 toggles off and writes the cleared activity action', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: ISSUE_ID, projectId: PROJECT_ID, manualHold: true },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'member',
    });

    const res = await buildApp().request(url, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ value: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issueId: ISSUE_ID, manualHold: false });
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'issue.manualHold.cleared' }),
    );
    // ISS-133 — clearing hold (true → false) fires a dispatch tick for the
    // project so queued jobs gated on `manual_hold` get re-evaluated.
    expect(dispatchTick).toHaveBeenCalledTimes(1);
    expect(dispatchTick).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('200 no-op when value matches current state (no write, no activity)', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: ISSUE_ID, projectId: PROJECT_ID, manualHold: true },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'member',
    });

    const res = await buildApp().request(url, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ value: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issueId: ISSUE_ID, manualHold: true });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(txUpdate).not.toHaveBeenCalled();
    expect(txInsertValues).not.toHaveBeenCalled();
    // ISS-133 — no transition means no tick.
    expect(dispatchTick).not.toHaveBeenCalled();
  });
});
