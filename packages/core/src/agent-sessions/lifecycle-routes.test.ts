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
}));

const buildChatPreamble = vi.fn(async () => '## Project Config\n\n---\n\n');
vi.mock('../lib/chat-preamble.js', () => ({
  buildChatPreamble: (id: string) => buildChatPreamble(id),
  TOOL_REFERENCE: '## Tool Reference (test)',
}));

const publishSpy = vi.fn(() => 1);
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
});

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
    selectLimit
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'apiflow',
          ownerId: 'someone-else',
          repoPath: '/repo',
          defaultDeviceId: null,
        },
      ])
      // loadProjectAccess: project lookup
      .mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: 'someone-else' }])
      // member lookup → no row
      .mockResolvedValueOnce([]);

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
    selectLimit
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'apiflow',
          ownerId: USER_ID,
          repoPath: '/repo',
          defaultDeviceId: null,
        },
      ])
      .mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: USER_ID }])
      .mockResolvedValueOnce([{ role: 'owner' }]);

    findAvailableDeviceForProject.mockResolvedValueOnce(DEVICE_ID);

    insertReturning.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        status: 'running',
        title: 'hello',
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
    selectLimit
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'apiflow',
          ownerId: USER_ID,
          repoPath: '/repo',
          defaultDeviceId: null,
        },
      ])
      .mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: USER_ID }])
      .mockResolvedValueOnce([{ role: 'owner' }]);

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
    selectLimit
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'apiflow',
          ownerId: USER_ID,
          repoPath: '/repo',
          defaultDeviceId: null,
        },
      ])
      .mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: USER_ID }])
      .mockResolvedValueOnce([{ role: 'owner' }]);
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

  it('still creates session when no device is available (UI surfaces no-device)', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'apiflow',
          ownerId: USER_ID,
          repoPath: '/repo',
          defaultDeviceId: null,
        },
      ])
      .mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: USER_ID }])
      .mockResolvedValueOnce([{ role: 'owner' }]);
    findAvailableDeviceForProject.mockResolvedValueOnce(null);
    insertReturning.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, deviceId: null, status: 'running' },
    ]);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/start', {
        method: 'POST',
        token,
        body: JSON.stringify({ projectSlug: 'apiflow', prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(201);
    // No device → no agent:start publish to a deviceRoom
    expect(
      publishSpy.mock.calls.find(
        ([_room, env]) => (env as any).event === 'agent:start',
      ),
    ).toBeUndefined();
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
    selectLimit
      .mockResolvedValueOnce([
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
      ])
      .mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: USER_ID }])
      .mockResolvedValueOnce([{ role: 'owner' }])
      .mockResolvedValueOnce([{ slug: 'apiflow' }]);
    updateReturning.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        status: 'running',
        repoPath: '/repo',
        claudeSessionId: null,
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
});

describe('POST /api/agent-sessions/abort', () => {
  it('200 sets status=idle + publishes agent:abort to device', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit
      .mockResolvedValueOnce([
        {
          id: SESSION_ID,
          projectId: PROJECT_ID,
          userId: USER_ID,
          deviceId: DEVICE_ID,
          metadata: { deviceId: DEVICE_ID },
        },
      ])
      .mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: USER_ID }])
      .mockResolvedValueOnce([{ role: 'owner' }]);
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
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'idle' }),
    );
    const abortCall = publishSpy.mock.calls.find(
      ([room, env]) => room === `device:${DEVICE_ID}` && (env as any).event === 'agent:abort',
    );
    expect(abortCall).toBeDefined();
  });

  it('403 when caller is not session owner and not project owner/admin', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit
      .mockResolvedValueOnce([
        {
          id: SESSION_ID,
          projectId: PROJECT_ID,
          userId: 'someone-else',
          deviceId: DEVICE_ID,
          metadata: {},
        },
      ])
      .mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: 'project-owner' }])
      .mockResolvedValueOnce([{ role: 'member' }]);

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
    selectLimit
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'apiflow',
          ownerId: USER_ID,
          repoPath: '/repo',
          defaultDeviceId: null,
        },
      ])
      .mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: USER_ID }])
      .mockResolvedValueOnce([{ role: 'owner' }]);
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
    selectLimit
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'apiflow',
          ownerId: USER_ID,
          repoPath: '/repo',
          defaultDeviceId: null,
        },
      ])
      .mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: USER_ID }])
      .mockResolvedValueOnce([{ role: 'owner' }]);
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

  it('returns connected=true when deviceId is online', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([{ status: 'online' }]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/agent-sessions/desktop/status?deviceId=${DEVICE_ID}`, { token }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { connected: boolean } };
    expect(body.data.connected).toBe(true);
  });

  it('returns connected=false when deviceId is offline', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([{ status: 'offline' }]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/agent-sessions/desktop/status?deviceId=${DEVICE_ID}`, { token }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { connected: boolean } };
    expect(body.data.connected).toBe(false);
  });

  it('returns connected=true when projectSlug has an online pool device', async () => {
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
    findAvailableDeviceForProject.mockResolvedValueOnce(DEVICE_ID);

    const app = buildApp();
    const res = await app.fetch(
      req('/api/agent-sessions/desktop/status?projectSlug=apiflow', { token }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { connected: boolean } };
    expect(body.data.connected).toBe(true);
  });

  it('returns connected=false when projectSlug has no online device', async () => {
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
    findAvailableDeviceForProject.mockResolvedValueOnce(null);

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
