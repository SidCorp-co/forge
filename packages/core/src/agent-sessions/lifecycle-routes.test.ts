import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectOrderByLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectOrderByLimit }));
const selectWhere = vi.fn(() => ({
  limit: selectLimit,
  orderBy: selectOrderBy,
}));
const selectInnerJoinWhere = vi.fn(() => ({ orderBy: selectOrderBy }));
const innerJoin = vi.fn(() => ({ where: selectInnerJoinWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, innerJoin }));

const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const dbInsert = vi.fn(() => ({ values: insertValues }));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn((_values: Record<string, unknown>) => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

vi.mock('../db/client.js', () => {
  const dbStub = {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: dbInsert,
    update: dbUpdate,
    delete: vi.fn(() => ({ where: vi.fn() })),
    execute: vi.fn(async () => []),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbStub)),
  };
  return { db: dbStub };
});

const findAvailableDeviceForProject = vi.fn();
const findChatCapableDeviceForProject = vi.fn();
const resolveSessionRepoPathForDevice = vi.fn(
  async (_projectId: string, _deviceId: string | null, projectRepoPath: string | null) =>
    projectRepoPath ?? null,
);
vi.mock('../lib/device-pool.js', () => ({
  findAvailableDeviceForProject: (id: string, opts?: object) =>
    findAvailableDeviceForProject(id, opts),
  findChatCapableDeviceForProject: (projectId: string, deviceId: string) =>
    findChatCapableDeviceForProject(projectId, deviceId),
  resolveRepoPath: (override: string | null | undefined, repo: string | null) =>
    (override ?? repo ?? '').trim() || null,
  resolveRunnerRepoPath: () => Promise.resolve(null),
  resolveSessionRepoPathForDevice: (
    projectId: string,
    deviceId: string | null,
    repo: string | null,
  ) => resolveSessionRepoPathForDevice(projectId, deviceId, repo),
}));

const buildChatPreamble = vi.fn(async (..._args: unknown[]) => '## Project Config\n\n---\n\n');
vi.mock('../lib/chat-preamble.js', () => ({
  buildChatPreamble: (id: string) => buildChatPreamble(id),
  TOOL_REFERENCE: '## Tool Reference (test)',
}));

const publishSpy = vi.fn((..._args: unknown[]) => 1);
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: publishSpy },
}));

vi.mock('../pipeline/activity.js', () => ({
  safeRecordActivity: vi.fn(async () => {}),
}));

// ISS-101 — interactive session inserts now open a pipeline_run first.
// Stub the helper so the chained db stub above doesn't need to model
// pipeline_runs.
vi.mock('../pipeline/runs.js', () => ({
  openIssueRun: vi.fn(async () => ({ id: 'run-1', startedAt: new Date() })),
  openOneShotRun: vi.fn(async () => ({ id: 'run-1' })),
  closeRun: vi.fn(async () => undefined),
  closeRunIfOneShot: vi.fn(async () => undefined),
  closeOpenRunForIssue: vi.fn(async () => undefined),
  setCurrentStep: vi.fn(async () => undefined),
  setCurrentStepForOpenIssueRun: vi.fn(async () => undefined),
}));

// Org-level authz: stub the db-touching resolvers; pure helpers stay real.
const projectAccessMock = vi.fn();
const loadVisibleProjectIdsMock = vi.fn(async () => [] as string[]);
const effectiveRoleMock = vi.fn(async () => ({ role: 'member' as string | null }));
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccessMock(...args),
  loadVisibleProjectIds: (...args: unknown[]) => loadVisibleProjectIdsMock(...(args as [])),
  effectiveProjectRole: () => effectiveRoleMock(),
}));

const mintSessionCredential = vi.fn(async () => 'forge_pat_test_turn');
vi.mock('./session-credential.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-credential.js')>()),
  resolveSessionAuthority: vi.fn(async () => ({
    ok: true,
    value: { authority: {}, menu: [] },
  })),
  mintSessionCredential: (...args: unknown[]) => mintSessionCredential(...(args as [])),
  revokeSessionCredential: vi.fn(async () => undefined),
}));

const { agentSessionRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
// ISS-1071 — the dispatch path reads the registry, which throws while empty.
(await import('../integrations/register-all.js')).registerAllIntegrations();

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/agent-sessions', agentSessionRoutes);
  app.onError(errorHandler);
  return app;
}

function req(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
  const { token: _t, ...rest } = init;
  return new Request(`http://localhost${path}`, { ...rest, headers });
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_DEVICE_ID = '66666666-6666-4666-8666-666666666666';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderByLimit.mockReset();
  insertReturning.mockReset();
  updateReturning.mockReset();
  projectAccessMock.mockReset();
  findChatCapableDeviceForProject.mockReset();
});

function grantAccess(role: 'admin' | 'member' | 'viewer' | null) {
  projectAccessMock.mockResolvedValueOnce({
    projectId: PROJECT_ID,
    orgId: 'org-1',
    role,
    orgRole: role === 'admin' ? 'owner' : null,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

function mockAuthVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

describe('POST /api/agent-sessions/send', () => {
  it('404 when session missing', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/send', {
        method: 'POST',
        token,
        body: JSON.stringify({ sessionId: SESSION_ID, message: 'm' }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('200 appends message + publishes agent:send to original device', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        deviceId: DEVICE_ID,
        messages: [{ role: 'user', content: 'first' }],
        metadata: { deviceId: DEVICE_ID },
        repoPath: '/repo',
        // A genuine follow-up already has a Claude session → agent:send.
        claudeSessionId: 'claude-abc',
      },
    ]);
    grantAccess('admin');
    selectLimit
      .mockResolvedValueOnce([{ status: 'online', capabilities: { followUpCredential: true } }])
      .mockResolvedValueOnce([{ id: PROJECT_ID, slug: 'apiflow', repoPath: '/repo' }]);
    updateReturning.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        status: 'running',
        repoPath: '/repo',
        claudeSessionId: 'claude-abc',
        metadata: { deviceId: DEVICE_ID },
        messages: [],
      },
    ]);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/send', {
        method: 'POST',
        token,
        body: JSON.stringify({ sessionId: SESSION_ID, message: 'second' }),
      }),
    );
    expect(res.status).toBe(200);
    const sendCall = publishSpy.mock.calls.find(
      ([room, env]) =>
        room === `device:${DEVICE_ID}` && (env as { event?: string }).event === 'agent:send',
    );
    if (!sendCall) throw new Error('no agent:send reached the box');
    const data = (sendCall[1] as { data: Record<string, unknown> }).data;
    expect(data.message).toBe('second');
    expect(data.projectSlug).toBe('apiflow');
    expect(data.forgeToken).toBe('forge_pat_test_turn');
  });

  it('409 SESSION_RUNNING refuses a follow-up while a turn is live, minting nothing', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        deviceId: DEVICE_ID,
        status: 'running',
        messages: [],
        metadata: { deviceId: DEVICE_ID },
        claudeSessionId: 'claude-abc',
      },
    ]);
    grantAccess('member');

    const res = await buildApp().fetch(
      req('/api/agent-sessions/send', {
        method: 'POST',
        token,
        body: JSON.stringify({ sessionId: SESSION_ID, message: 'second' }),
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('SESSION_RUNNING');
    expect(mintSessionCredential).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('409 NO_CLAUDE_CLIENT when the pinned device is offline (ISS-420)', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        deviceId: DEVICE_ID,
        messages: [{ role: 'user', content: 'first' }],
        metadata: { deviceId: DEVICE_ID },
        repoPath: '/repo',
        claudeSessionId: null,
      },
    ]);
    grantAccess('admin');
    selectLimit
      .mockResolvedValueOnce([{ status: 'offline' }])
      .mockResolvedValueOnce([{ status: 'offline' }]);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/send', {
        method: 'POST',
        token,
        body: JSON.stringify({ sessionId: SESSION_ID, message: 'second' }),
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('NO_CLAUDE_CLIENT');
    expect(updateReturning).not.toHaveBeenCalled();
  });
});

describe('POST /api/agent-sessions/abort', () => {
  it('200 sets status=idle + publishes agent:abort to device', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        deviceId: DEVICE_ID,
        metadata: { deviceId: DEVICE_ID },
      },
    ]);
    grantAccess('admin');
    updateReturning.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        status: 'idle',
        metadata: { deviceId: DEVICE_ID },
      },
    ]);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/abort', {
        method: 'POST',
        token,
        body: JSON.stringify({ sessionId: SESSION_ID }),
      }),
    );
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'idle' }));
    const abortCall = publishSpy.mock.calls.find(
      ([room, env]) => room === `device:${DEVICE_ID}` && (env as any).event === 'agent:abort',
    );
    expect(abortCall).toBeDefined();
  });

  it('403 when caller is not session owner and not project owner/admin', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        userId: 'someone-else',
        deviceId: DEVICE_ID,
        metadata: {},
      },
    ]);
    grantAccess('member');

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/abort', {
        method: 'POST',
        token,
        body: JSON.stringify({ sessionId: SESSION_ID }),
      }),
    );
    expect(res.status).toBe(403);
    expect(updateSet).not.toHaveBeenCalled();
  });
});

describe('POST /api/agent-sessions/:id/runner', () => {
  it('200 re-pins deviceId + metadata.deviceId, nulls claudeSessionId, writes the NEW device repoPath, broadcasts agent-session.updated', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        deviceId: DEVICE_ID,
        metadata: { deviceId: DEVICE_ID },
        status: 'idle',
        claudeSessionId: 'claude-abc',
        repoPath: '/repo/on/old-device',
      },
    ]);
    grantAccess('admin');
    findChatCapableDeviceForProject.mockResolvedValueOnce(OTHER_DEVICE_ID);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, repoPath: '/repo' }]);
    resolveSessionRepoPathForDevice.mockResolvedValueOnce('/repo/on/new-device');
    updateReturning.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: OTHER_DEVICE_ID,
        metadata: { deviceId: OTHER_DEVICE_ID },
        status: 'idle',
        claudeSessionId: null,
        repoPath: '/repo/on/new-device',
      },
    ]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/agent-sessions/${SESSION_ID}/runner`, {
        method: 'POST',
        token,
        body: JSON.stringify({ deviceId: OTHER_DEVICE_ID }),
      }),
    );
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: OTHER_DEVICE_ID,
        metadata: expect.objectContaining({ deviceId: OTHER_DEVICE_ID }),
        claudeSessionId: null,
        repoPath: '/repo/on/new-device',
      }),
    );
    const updateCall = publishSpy.mock.calls.find(
      ([, env]) => (env as { event: string }).event === 'agent-session.updated',
    );
    expect(updateCall).toBeDefined();
  });

  it('409 NO_CLAUDE_CLIENT when the picked device is offline/disabled/not a chat runner', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        deviceId: DEVICE_ID,
        metadata: { deviceId: DEVICE_ID },
        status: 'idle',
        claudeSessionId: 'claude-abc',
        repoPath: '/repo/on/old-device',
      },
    ]);
    grantAccess('admin');
    findChatCapableDeviceForProject.mockResolvedValueOnce(null);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, repoPath: '/repo' }]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/agent-sessions/${SESSION_ID}/runner`, {
        method: 'POST',
        token,
        body: JSON.stringify({ deviceId: OTHER_DEVICE_ID }),
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('NO_CLAUDE_CLIENT');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('409 NO_REPO_PATH when the picked device has no runner binding and the project has no default repoPath (ISS-755 fix)', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        deviceId: DEVICE_ID,
        metadata: { deviceId: DEVICE_ID },
        status: 'idle',
        claudeSessionId: 'claude-abc',
        repoPath: '/repo/on/old-device',
      },
    ]);
    grantAccess('admin');
    findChatCapableDeviceForProject.mockResolvedValueOnce(OTHER_DEVICE_ID);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, repoPath: null }]);
    resolveSessionRepoPathForDevice.mockResolvedValueOnce(null);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/agent-sessions/${SESSION_ID}/runner`, {
        method: 'POST',
        token,
        body: JSON.stringify({ deviceId: OTHER_DEVICE_ID }),
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('NO_REPO_PATH');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('409 SESSION_BUSY while the session is running', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        deviceId: DEVICE_ID,
        metadata: { deviceId: DEVICE_ID },
        status: 'running',
        claudeSessionId: 'claude-abc',
      },
    ]);
    grantAccess('admin');

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/agent-sessions/${SESSION_ID}/runner`, {
        method: 'POST',
        token,
        body: JSON.stringify({ deviceId: OTHER_DEVICE_ID }),
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('SESSION_BUSY');
    expect(updateSet).not.toHaveBeenCalled();
    expect(findChatCapableDeviceForProject).not.toHaveBeenCalled();
  });

  it('{ deviceId: null } clears the pin + metadata.deviceId + repoPath (Auto)', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        deviceId: DEVICE_ID,
        metadata: { deviceId: DEVICE_ID },
        status: 'idle',
        claudeSessionId: 'claude-abc',
        repoPath: '/repo/on/old-device',
      },
    ]);
    grantAccess('admin');
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, repoPath: '/repo' }]);
    updateReturning.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: null,
        metadata: {},
        status: 'idle',
        claudeSessionId: null,
        repoPath: null,
      },
    ]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/agent-sessions/${SESSION_ID}/runner`, {
        method: 'POST',
        token,
        body: JSON.stringify({ deviceId: null }),
      }),
    );
    expect(res.status).toBe(200);
    expect(findChatCapableDeviceForProject).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: null, claudeSessionId: null, repoPath: null }),
    );
    const updates = updateSet.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> };
    expect(updates.metadata?.deviceId).toBeUndefined();
  });

  it('same-device (idempotent) pick → no-op, keeps claudeSessionId (no needless --resume loss)', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        deviceId: DEVICE_ID,
        metadata: { deviceId: DEVICE_ID },
        status: 'idle',
        claudeSessionId: 'claude-abc',
        repoPath: '/repo/on/old-device',
      },
    ]);
    grantAccess('admin');

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/agent-sessions/${SESSION_ID}/runner`, {
        method: 'POST',
        token,
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      }),
    );
    expect(res.status).toBe(200);
    expect(updateSet).not.toHaveBeenCalled();
    expect(findChatCapableDeviceForProject).not.toHaveBeenCalled();
    const body = (await res.json()) as { claudeSessionId?: string | null };
    expect(body.claudeSessionId).toBe('claude-abc');
  });
});

describe('GET /api/agent-sessions/desktop/status', () => {
  it('400 when neither deviceId nor projectSlug provided', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();

    const app = buildApp();
    const res = await app.fetch(req('/api/agent-sessions/desktop/status', { token }));
    expect(res.status).toBe(400);
  });

  it('returns connected=true when deviceId is online and caller owns the device', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    // ISS-492: device row now carries ownerId; owner sees the real bit.
    selectLimit.mockResolvedValueOnce([{ status: 'online', ownerId: USER_ID }]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/agent-sessions/desktop/status?deviceId=${DEVICE_ID}`, { token }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { connected: boolean } };
    expect(body.data.connected).toBe(true);
  });

  it('returns connected=false when deviceId is offline and caller owns the device', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([{ status: 'offline', ownerId: USER_ID }]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/agent-sessions/desktop/status?deviceId=${DEVICE_ID}`, { token }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { connected: boolean } };
    expect(body.data.connected).toBe(false);
  });

  it('ISS-492: deviceId owned by another tenant → non-revealing connected=false', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    // Online device owned by someone else; caller shares no project (runners
    // lookup returns no row). Must not reveal the real online bit.
    selectLimit
      .mockResolvedValueOnce([{ status: 'online', ownerId: 'someone-else' }]) // device
      .mockResolvedValueOnce([]); // runners visibility join — no shared project
    loadVisibleProjectIdsMock.mockResolvedValueOnce([PROJECT_ID]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/agent-sessions/desktop/status?deviceId=${DEVICE_ID}`, { token }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { connected: boolean } };
    expect(body.data.connected).toBe(false);
  });

  it('returns connected=true when projectSlug has an online pool device and caller is a member', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: PROJECT_ID,
        slug: 'apiflow',
        ownerId: USER_ID,
        repoPath: '/repo',
        defaultDeviceId: null,
      },
    ]);
    projectAccessMock.mockResolvedValueOnce({ role: 'member' });
    findAvailableDeviceForProject.mockResolvedValueOnce(DEVICE_ID);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/desktop/status?projectSlug=apiflow', { token }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { connected: boolean } };
    expect(body.data.connected).toBe(true);
  });

  it('returns connected=false when projectSlug has no online device (caller is a member)', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: PROJECT_ID,
        slug: 'apiflow',
        ownerId: USER_ID,
        repoPath: null,
        defaultDeviceId: null,
      },
    ]);
    projectAccessMock.mockResolvedValueOnce({ role: 'member' });
    findAvailableDeviceForProject.mockResolvedValueOnce(null);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/desktop/status?projectSlug=apiflow', { token }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { connected: boolean } };
    expect(body.data.connected).toBe(false);
  });

  it('ISS-492: projectSlug of a non-member tenant → non-revealing connected=false', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: PROJECT_ID,
        slug: 'apiflow',
        ownerId: 'someone-else',
        repoPath: null,
        defaultDeviceId: null,
      },
    ]);
    projectAccessMock.mockResolvedValueOnce({ role: null }); // not a member
    findAvailableDeviceForProject.mockResolvedValueOnce(DEVICE_ID); // would be online, but gated

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/desktop/status?projectSlug=apiflow', { token }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { connected: boolean } };
    expect(body.data.connected).toBe(false);
  });

  it('returns connected=false when project slug missing', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([]); // loadProjectBySlug → empty

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/desktop/status?projectSlug=ghost', { token }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { connected: boolean } };
    expect(body.data.connected).toBe(false);
  });
});
