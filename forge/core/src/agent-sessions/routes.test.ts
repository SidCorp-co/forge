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

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: deleteWhere })),
  },
}));

const publishSpy = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: publishSpy },
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
  selectOrderBy.mockReset();
  insertReturning.mockReset();
  updateReturning.mockReset();
  whereResults.length = 0;
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

function projectAccessAsMember() {
  selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: 'someone-else' }]);
  selectLimit.mockResolvedValueOnce([{ role: 'member' }]);
}

function projectAccessAsOwner() {
  selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: USER_ID }]);
  selectLimit.mockResolvedValueOnce([]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/agent-sessions', () => {
  it('400 without projectId or deviceId', async () => {
    authVerified();
    const res = await buildApp().request('/api/agent-sessions', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });

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
  it('merges + broadcasts control', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, deviceId: DEVICE_ID, status: 'running', pipelineControl: { paused: false } },
    ]);
    projectAccessAsMember();
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
    const json = (await res.json()) as { paused: boolean };
    expect(json.paused).toBe(true);
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
