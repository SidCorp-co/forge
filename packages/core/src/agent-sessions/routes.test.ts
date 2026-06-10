import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const whereResults: unknown[][] = [];
const selectLimit = vi.fn();
const selectOrderByOffset = vi.fn();
const selectOrderByLimit = vi.fn(() => ({ offset: selectOrderByOffset }));
const selectOrderBy = vi.fn(() => ({ limit: selectOrderByLimit }));
const selectWhere = vi.fn(() => ({
  limit: selectLimit,
  orderBy: selectOrderBy,
  // The list handler's per-page cost rollup (ISS-391) ends in
  // `.where(...).groupBy(usageRecords.sessionId)` and is awaited directly, so
  // the where-chain needs a thenable groupBy. It pulls from the same
  // `whereResults` queue as `then` (push a cost-rollup row to assert
  // estimatedCost attachment; defaults to [] → estimatedCost 0).
  groupBy: () => ({
    then: (cb: (v: unknown) => unknown) => {
      const result = whereResults.shift() ?? [];
      return Promise.resolve(result).then(cb);
    },
  }),
  then: (cb: (v: unknown) => unknown) => {
    const result = whereResults.shift() ?? [];
    return Promise.resolve(result).then(cb);
  },
}));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const deleteWhere = vi.fn(() => Promise.resolve());

vi.mock('../db/client.js', () => {
  const dbStub = {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: deleteWhere })),
    // Route handlers run dual-write inside db.transaction; pass the same stub
    // through so mocked .insert/.update/.delete chains keep working.
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbStub)),
  };
  return { db: dbStub };
});

const publishSpy = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: publishSpy },
}));

// ISS-321 — POST /start resolves a Claude-capable device via device-pool.
// Mock it so the no-online-client guard can be exercised deterministically.
const findAvailableDeviceMock = vi.fn(async (_projectId: string) => null as string | null);
vi.mock('../lib/device-pool.js', () => ({
  findAvailableDeviceForProject: (projectId: string) => findAvailableDeviceMock(projectId),
  resolveRepoPath: (override: string | null | undefined, projectRepoPath: string | null) =>
    (override ?? projectRepoPath ?? '').trim() || null,
}));

const safeRecordActivitySpy = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../pipeline/activity.js', () => ({
  safeRecordActivity: safeRecordActivitySpy,
}));

// ISS-101 — every interactive session insert now opens a pipeline_run first.
// Stub the helper so we don't have to teach the chained db stub above to
// model pipeline_runs SELECT/INSERT alongside agent_sessions.
vi.mock('../pipeline/runs.js', () => ({
  openIssueRun: vi.fn(async () => ({ id: 'run-1', startedAt: new Date() })),
  openOneShotRun: vi.fn(async () => ({ id: 'run-1' })),
  closeRun: vi.fn(async () => undefined),
  closeRunIfOneShot: vi.fn(async () => undefined),
  closeOpenRunForIssue: vi.fn(async () => undefined),
  setCurrentStep: vi.fn(async () => undefined),
  setCurrentStepForOpenIssueRun: vi.fn(async () => undefined),
}));

// Org-level authz: stub the db-touching resolvers; pure helpers
// (assertProjectRole, projectRoleAtLeast) stay real.
const projectAccessMock = vi.fn();
const visibleIdsMock = vi.fn(async (_userId: string) => [] as string[]);
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccessMock(...args),
  loadVisibleProjectIds: (...args: unknown[]) => visibleIdsMock(...(args as [string])),
}));

const { agentSessionRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/agent-sessions', agentSessionRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderByOffset.mockReset();
  // Factory mocks that return chained-method objects must keep their
  // implementation across tests — mockReset would wipe `() => ({ limit:… })`
  // and the next chain call would explode on `undefined.limit`.
  selectOrderBy.mockClear();
  insertReturning.mockReset();
  updateReturning.mockReset();
  projectAccessMock.mockReset();
  visibleIdsMock.mockReset();
  visibleIdsMock.mockResolvedValue([]);
  whereResults.length = 0;
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

function projectAccessAsMember() {
  projectAccessMock.mockResolvedValueOnce({
    projectId: PROJECT_ID,
    orgId: 'org-1',
    role: 'member',
    orgRole: null,
  });
}

function projectAccessAsOwner() {
  projectAccessMock.mockResolvedValueOnce({
    projectId: PROJECT_ID,
    orgId: 'org-1',
    role: 'admin',
    orgRole: 'owner',
  });
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/agent-sessions', () => {
  // Note: the previous "400 without projectId or deviceId" test was removed
  // when the cross-project path was added — calls without those filters now
  // return the caller's visible-project sessions (mirroring chat-logs).
  // That path mixes `db.selectDistinct` + `leftJoin` which the bare drizzle
  // mock here doesn't model; integration tests on staging cover it instead.

  it('returns scoped list with X-Total-Count', async () => {
    authVerified();
    projectAccessAsMember();
    whereResults.push([{ n: 1 }]);
    selectOrderByOffset.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, deviceId: null, status: 'idle' },
    ]);
    const res = await buildApp().request(`/api/agent-sessions?projectId=${PROJECT_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Total-Count')).toBe('1');
  });
});

describe('POST /api/agent-sessions', () => {
  it('creates and broadcasts to project + device rooms', async () => {
    authVerified();
    projectAccessAsMember();
    insertReturning.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, deviceId: DEVICE_ID, status: 'idle' },
    ]);
    const res = await buildApp().request('/api/agent-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, deviceId: DEVICE_ID }),
    });
    expect(res.status).toBe(201);
    const rooms = publishSpy.mock.calls.map((c) => c[0]);
    expect(rooms).toContain(`project:${PROJECT_ID}`);
    expect(rooms).toContain(`device:${DEVICE_ID}`);
  });
});

describe('POST /api/agent-sessions/start — no-online-client guard (ISS-321)', () => {
  it('returns 409 NO_CLAUDE_CLIENT when no online Claude client is available', async () => {
    authVerified();
    // loadProjectBySlug → a project with no default device.
    selectLimit.mockResolvedValueOnce([
      {
        id: PROJECT_ID,
        slug: 'app',
        ownerId: USER_ID,
        repoPath: '/repo',
        defaultDeviceId: null,
      },
    ]);
    projectAccessAsMember();
    findAvailableDeviceMock.mockResolvedValueOnce(null); // nobody online

    const res = await buildApp().request('/api/agent-sessions/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectSlug: 'app', prompt: 'hello' }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('NO_CLAUDE_CLIENT');
    // The session must NOT be created and no agent:start must be published.
    expect(insertReturning).not.toHaveBeenCalled();
    const events = publishSpy.mock.calls.map((c) => (c[1] as { event?: string } | undefined)?.event);
    expect(events).not.toContain('agent:start');
  });
});

describe('PATCH /api/agent-sessions/:id status change', () => {
  it('emits agent-session.status when status changes', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, deviceId: null, status: 'idle' },
    ]);
    projectAccessAsMember();
    updateReturning.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, deviceId: null, status: 'running' },
    ]);
    const res = await buildApp().request(`/api/agent-sessions/${SESSION_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ status: 'running' }),
    });
    expect(res.status).toBe(200);
    const events = publishSpy.mock.calls.map((c) => (c[1] as { event: string }).event);
    expect(events).toContain('agent-session.status');
  });
});

describe('POST /api/agent-sessions/:id/pipeline-control', () => {
  it('merges + broadcasts control when caller is owner', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, deviceId: DEVICE_ID, status: 'running', pipelineControl: { paused: false }, metadata: null },
    ]);
    projectAccessAsOwner();
    updateReturning.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, deviceId: DEVICE_ID, status: 'running' },
    ]);
    const res = await buildApp().request(
      `/api/agent-sessions/${SESSION_ID}/pipeline-control`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ paused: true, reason: 'manual' }),
      },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      paused: boolean;
      pausedBy: string | null;
      pausedAt: string | null;
      reason: string | null;
    };
    expect(json.paused).toBe(true);
    expect(json.pausedBy).toBe(USER_ID);
    expect(json.pausedAt).not.toBeNull();
    expect(json.reason).toBe('manual');
    const events = publishSpy.mock.calls.map((c) => (c[1] as { event: string }).event);
    expect(events).toContain('agent-session.pipeline-control');
  });

  it('records activity when session is bound to an issue', async () => {
    authVerified();
    const ISSUE_ID = '55555555-5555-4555-8555-555555555555';
    selectLimit.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        status: 'running',
        pipelineControl: { paused: false },
        metadata: { issueId: ISSUE_ID },
      },
    ]);
    projectAccessAsOwner();
    updateReturning.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, deviceId: DEVICE_ID, status: 'running' },
    ]);
    const res = await buildApp().request(
      `/api/agent-sessions/${SESSION_ID}/pipeline-control`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ paused: true, reason: 'manual' }),
      },
    );
    expect(res.status).toBe(200);
    expect(safeRecordActivitySpy).toHaveBeenCalledTimes(1);
    const arg = safeRecordActivitySpy.mock.calls[0]?.[0] as {
      issueId: string;
      action: string;
      payload?: { paused: boolean; reason: string | null };
    };
    expect(arg.issueId).toBe(ISSUE_ID);
    expect(arg.action).toBe('agent-session.pipelineControl.changed');
    expect(arg.payload?.paused).toBe(true);
    expect(arg.payload?.reason).toBe('manual');
  });

  it('skips activity log when session has no issueId metadata', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        status: 'running',
        pipelineControl: null,
        metadata: null,
      },
    ]);
    projectAccessAsOwner();
    updateReturning.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, deviceId: DEVICE_ID, status: 'running' },
    ]);
    const res = await buildApp().request(
      `/api/agent-sessions/${SESSION_ID}/pipeline-control`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ paused: true }),
      },
    );
    expect(res.status).toBe(200);
    expect(safeRecordActivitySpy).not.toHaveBeenCalled();
  });

  it('rejects plain members with 403', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, deviceId: DEVICE_ID, status: 'running', pipelineControl: null, metadata: null },
    ]);
    projectAccessAsMember();
    const res = await buildApp().request(
      `/api/agent-sessions/${SESSION_ID}/pipeline-control`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ paused: true }),
      },
    );
    expect(res.status).toBe(403);
  });
});

describe('GET /api/agent-sessions/:id/pipeline-health', () => {
  it('returns the stored health when present', async () => {
    authVerified();
    const stored = {
      retryCount: 3,
      recoveryStats: {
        totalFailures: 3,
        byKind: { transient: 2, permission: 0, permanent: 0, timeout: 1 },
        lastFailureAt: new Date().toISOString(),
        lastFailureKind: 'timeout',
        autoRetries: 1,
      },
      lastError: { message: 'boom', ts: new Date().toISOString(), jobId: null },
      updatedAt: new Date().toISOString(),
    };
    selectLimit.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, pipelineHealth: stored },
    ]);
    projectAccessAsMember();
    const res = await buildApp().request(
      `/api/agent-sessions/${SESSION_ID}/pipeline-health`,
      { headers: { authorization: `Bearer ${await token()}` } },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { retryCount: number };
    expect(json.retryCount).toBe(3);
  });

  it('returns the default shape when health is null', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, pipelineHealth: null },
    ]);
    projectAccessAsMember();
    const res = await buildApp().request(
      `/api/agent-sessions/${SESSION_ID}/pipeline-health`,
      { headers: { authorization: `Bearer ${await token()}` } },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { retryCount: number; lastError: unknown };
    expect(json.retryCount).toBe(0);
    expect(json.lastError).toBeNull();
  });
});

describe('POST /api/agent-sessions/:id/relay', () => {
  it('broadcasts relay to project + device rooms', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, deviceId: DEVICE_ID, status: 'running' },
    ]);
    projectAccessAsMember();
    const res = await buildApp().request(`/api/agent-sessions/${SESSION_ID}/relay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ event: 'log', data: { line: 'hi' } }),
    });
    expect(res.status).toBe(200);
    const events = publishSpy.mock.calls.map((c) => (c[1] as { event: string }).event);
    expect(events).toContain('agent-session.relay.log');
  });
});

describe('POST /api/agent-sessions/desktop/status', () => {
  it('updates status for the listed session', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, deviceId: DEVICE_ID, status: 'idle' },
    ]);
    projectAccessAsOwner();
    updateReturning.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, deviceId: DEVICE_ID, status: 'completed' },
    ]);
    const res = await buildApp().request('/api/agent-sessions/desktop/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ sessionId: SESSION_ID, status: 'completed' }),
    });
    expect(res.status).toBe(200);
  });
});
