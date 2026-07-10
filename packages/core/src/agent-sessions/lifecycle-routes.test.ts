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
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

vi.mock('../db/client.js', () => {
  const dbStub = {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: dbInsert,
    update: dbUpdate,
    delete: vi.fn(() => ({ where: vi.fn() })),
    // Route handlers run dual-write inside db.transaction; pass the same stub
    // through so mocked .insert/.update/.delete chains keep working.
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbStub)),
  };
  return { db: dbStub };
});

const findAvailableDeviceForProject = vi.fn();
vi.mock('../lib/device-pool.js', () => ({
  findAvailableDeviceForProject: (id: string) => findAvailableDeviceForProject(id),
  resolveRepoPath: (override: string | null | undefined, repo: string | null) =>
    (override ?? repo ?? '').trim() || null,
  resolveRunnerRepoPath: () => Promise.resolve(null),
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
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccessMock(...args),
  loadVisibleProjectIds: (...args: unknown[]) => loadVisibleProjectIdsMock(...(args as [])),
}));

// The handlers under test live in ./lifecycle-routes.ts, but we deliberately
// go through the ./routes.ts aggregator: the shared auth middleware
// (requireUserOrDevice + assertEmailVerified) is registered there, and mounting
// through it also verifies the lifecycle sub-router's URLs stayed identical.
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

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderByLimit.mockReset();
  insertReturning.mockReset();
  updateReturning.mockReset();
  projectAccessMock.mockReset();
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

describe('POST /api/agent-sessions/start', () => {
  it('400 when body missing prompt for non-agent session', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/start', {
        method: 'POST',
        token,
        body: JSON.stringify({ projectSlug: 'apiflow' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('404 when project slug missing', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([]); // loadProjectBySlug → empty

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/start', {
        method: 'POST',
        token,
        body: JSON.stringify({ projectSlug: 'no-such', prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('403 when caller not a project member', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: PROJECT_ID,
        slug: 'apiflow',
        ownerId: 'someone-else',
        repoPath: '/repo',
        defaultDeviceId: null,
      },
    ]);
    grantAccess(null);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/start', {
        method: 'POST',
        token,
        body: JSON.stringify({ projectSlug: 'apiflow', prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('201 creates session, publishes agent:start with TOOL_REFERENCE + preamble', async () => {
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
    grantAccess('admin');

    findAvailableDeviceForProject.mockResolvedValueOnce(DEVICE_ID);

    // createChatSessionRow inserts an EMPTY row (idle, no device, no claude id).
    insertReturning.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: null,
        status: 'idle',
        title: 'hello',
        messages: [],
        claudeSessionId: null,
      },
    ]);
    // dispatchChatTurn flips it to running + pins the device in the tx.update.
    updateReturning.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        status: 'running',
        title: 'hello',
        claudeSessionId: null,
      },
    ]);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/start', {
        method: 'POST',
        token,
        body: JSON.stringify({ projectSlug: 'apiflow', prompt: 'hello' }),
      }),
    );
    expect(res.status).toBe(201);
    expect(buildChatPreamble).toHaveBeenCalledWith(PROJECT_ID);
    const startCall = publishSpy.mock.calls.find(
      ([room, env]) => room === `device:${DEVICE_ID}` && (env as any).event === 'agent:start',
    );
    expect(startCall).toBeDefined();
    const data = (startCall![1] as { data: any }).data;
    expect(data.sessionId).toBe(SESSION_ID);
    expect(data.projectSlug).toBe('apiflow');
    expect(data.systemPrompt).toBe('## Tool Reference (test)');
    expect(String(data.prompt)).toContain('hello');
  });

  it('publishes agent:review for agent-type sessions, skips preamble', async () => {
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
    grantAccess('admin');

    findAvailableDeviceForProject.mockResolvedValueOnce(DEVICE_ID);

    insertReturning.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        status: 'running',
        title: 'qa Review',
      },
    ]);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/start', {
        method: 'POST',
        token,
        body: JSON.stringify({ projectSlug: 'apiflow', type: 'qa' }),
      }),
    );
    expect(res.status).toBe(201);
    expect(buildChatPreamble).not.toHaveBeenCalled();
    const reviewCall = publishSpy.mock.calls.find(
      ([room, env]) => room === `device:${DEVICE_ID}` && (env as any).event === 'agent:review',
    );
    expect(reviewCall).toBeDefined();
  });

  it('publishes agent:reindex for *-reindex sessions', async () => {
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
    grantAccess('admin');
    findAvailableDeviceForProject.mockResolvedValueOnce(DEVICE_ID);
    insertReturning.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, deviceId: DEVICE_ID, status: 'running' },
    ]);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/start', {
        method: 'POST',
        token,
        body: JSON.stringify({ projectSlug: 'apiflow', type: 'qa-reindex' }),
      }),
    );
    expect(res.status).toBe(201);
    const reindexCall = publishSpy.mock.calls.find(
      ([room, env]) => room === `device:${DEVICE_ID}` && (env as any).event === 'agent:reindex',
    );
    expect(reindexCall).toBeDefined();
  });

  it('409 NO_CLAUDE_CLIENT when no online Claude client is available (ISS-321)', async () => {
    // Previously this created a session that sat silent (no agent:start
    // listener). ISS-321 fails fast instead so the user gets clear feedback.
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
    grantAccess('admin');
    findAvailableDeviceForProject.mockResolvedValueOnce(null);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/start', {
        method: 'POST',
        token,
        body: JSON.stringify({ projectSlug: 'apiflow', prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('NO_CLAUDE_CLIENT');
    // The session must NOT be created and no agent:start must be published.
    expect(insertReturning).not.toHaveBeenCalled();
    expect(
      publishSpy.mock.calls.find(([_room, env]) => (env as any).event === 'agent:start'),
    ).toBeUndefined();
  });

  it('409 NO_CLAUDE_CLIENT for an agent-type session with no online client (ISS-420)', async () => {
    // ISS-420: the guard used to EXEMPT agent-type sessions, so a review/reindex
    // dispatched with no online device was created `running` and hung silently.
    // It must now fail fast like a chat does.
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
    grantAccess('admin');
    findAvailableDeviceForProject.mockResolvedValueOnce(null);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/start', {
        method: 'POST',
        token,
        body: JSON.stringify({ projectSlug: 'apiflow', type: 'qa' }),
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('NO_CLAUDE_CLIENT');
    expect(insertReturning).not.toHaveBeenCalled();
  });
});

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
      .mockResolvedValueOnce([{ status: 'online' }]) // resolveChatDevice: pinned device online
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
      ([room, env]) => room === `device:${DEVICE_ID}` && (env as any).event === 'agent:send',
    );
    expect(sendCall).toBeDefined();
    expect((sendCall![1] as { data: any }).data.message).toBe('second');
    expect((sendCall![1] as { data: any }).data.projectSlug).toBe('apiflow');
  });

  it('409 NO_CLAUDE_CLIENT when the pinned device is offline (ISS-420)', async () => {
    // ISS-420: /send used to set status=running + append the message, then
    // silently skip the publish when the device was gone — an undeliverable
    // follow-up that hung forever. It must fail fast without mutating.
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
    selectLimit.mockResolvedValueOnce([{ status: 'offline' }]); // pinned device offline

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

describe('POST /api/agent-sessions/build-prompt', () => {
  it('503 when no device is available for the project', async () => {
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
    grantAccess('admin');
    findAvailableDeviceForProject.mockResolvedValueOnce(null);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/build-prompt', {
        method: 'POST',
        token,
        body: JSON.stringify({
          projectSlug: 'apiflow',
          issueIds: ['66666666-6666-4666-8666-666666666666'],
        }),
      }),
    );
    expect(res.status).toBe(503);
  });

  it('200 returns requestId + publishes agent:build-prompt to device', async () => {
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
    grantAccess('admin');
    findAvailableDeviceForProject.mockResolvedValueOnce(DEVICE_ID);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/build-prompt', {
        method: 'POST',
        token,
        body: JSON.stringify({
          projectSlug: 'apiflow',
          issueIds: ['66666666-6666-4666-8666-666666666666'],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requestId: string };
    expect(typeof body.requestId).toBe('string');
    const buildCall = publishSpy.mock.calls.find(
      ([room, env]) =>
        room === `device:${DEVICE_ID}` && (env as any).event === 'agent:build-prompt',
    );
    expect(buildCall).toBeDefined();
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

describe('POST /api/agent-sessions/prompt-built', () => {
  it('400 when neither prompt nor error is provided', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/prompt-built', {
        method: 'POST',
        token,
        body: JSON.stringify({ requestId: 'abc' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('200 broadcasts the result to the agent:prompt-built room', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/prompt-built', {
        method: 'POST',
        token,
        body: JSON.stringify({ requestId: 'abc', prompt: 'composed' }),
      }),
    );
    expect(res.status).toBe(200);
    const call = publishSpy.mock.calls.find(
      ([room, env]) => room === 'agent:prompt-built' && (env as any).event === 'agent:prompt-built',
    );
    expect(call).toBeDefined();
    expect((call![1] as { data: any }).data.prompt).toBe('composed');
  });
});
