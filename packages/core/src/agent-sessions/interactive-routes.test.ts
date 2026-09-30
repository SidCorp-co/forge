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
const _OTHER_DEVICE_ID = '66666666-6666-4666-8666-666666666666';

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

  it('400s a model selection for a typed legacy session before creating it', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();

    const res = await buildApp().fetch(
      req('/api/agent-sessions/start', {
        method: 'POST',
        token,
        body: JSON.stringify({ projectSlug: 'apiflow', type: 'qa', model: 'opus' }),
      }),
    );

    expect(res.status).toBe(400);
    expect(insertReturning).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
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
      ([room, env]) =>
        room === `device:${DEVICE_ID}` && (env as { event?: string }).event === 'agent:start',
    );
    if (!startCall) throw new Error('no agent:start reached the box');
    const data = (startCall[1] as { data: Record<string, unknown> }).data;
    expect(data.sessionId).toBe(SESSION_ID);
    expect(data.projectSlug).toBe('apiflow');
    expect(data.systemPrompt).toBe('## Tool Reference (test)');
    expect(String(data.prompt)).toContain('hello');
    expect(data.forgeToken).toBe('forge_pat_test_turn');
    expect(mintSessionCredential).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, deviceId: DEVICE_ID }),
    );
  });

});

describe('POST /api/agent-sessions/start refuses before a row is created', () => {
  it('403 SESSION_VIEWER refuses a viewer before a row is created', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      { id: PROJECT_ID, slug: 'apiflow', repoPath: '/repo', defaultDeviceId: null },
    ]);
    grantAccess('viewer');

    const res = await buildApp().fetch(
      req('/api/agent-sessions/start', {
        method: 'POST',
        token,
        body: JSON.stringify({ projectSlug: 'apiflow', prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('SESSION_VIEWER');
    expect(insertReturning).not.toHaveBeenCalled();
  });

  it('409 RUNNER_OUTDATED when only a runner that cannot carry the token is free', async () => {
    const token = await signUserToken(USER_ID);
    mockAuthVerified();
    selectLimit.mockResolvedValueOnce([
      { id: PROJECT_ID, slug: 'apiflow', repoPath: '/repo', defaultDeviceId: null },
    ]);
    grantAccess('member');
    findAvailableDeviceForProject.mockImplementation(async (_id: string, opts?: object) =>
      opts && 'requireCapability' in opts ? null : DEVICE_ID,
    );

    const res = await buildApp().fetch(
      req('/api/agent-sessions/start', {
        method: 'POST',
        token,
        body: JSON.stringify({ projectSlug: 'apiflow', prompt: 'hi' }),
      }),
    );
    findAvailableDeviceForProject.mockReset();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('RUNNER_OUTDATED');
    expect(insertReturning).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it.each(['qa', 'qa-reindex'])(
    'rejects retired typed session %s before a row is created',
    async (type) => {
      const token = await signUserToken(USER_ID);
      mockAuthVerified();

      const res = await buildApp().fetch(
        req('/api/agent-sessions/start', {
          method: 'POST',
          token,
          body: JSON.stringify({ projectSlug: 'apiflow', type }),
        }),
      );

      expect(res.status).toBe(400);
      expect(insertReturning).not.toHaveBeenCalled();
      expect(publishSpy).not.toHaveBeenCalled();
    },
  );

  it('409 NO_CLAUDE_CLIENT when no online Claude client is available (ISS-321)', async () => {
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
      publishSpy.mock.calls.find(
        ([_room, env]) => (env as { event?: string }).event === 'agent:start',
      ),
    ).toBeUndefined();
  });
});
