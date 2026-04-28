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

const { chatSessionRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/chat-sessions', chatSessionRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

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
  whereResults.length = 0;
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

function projectAccessAsMember() {
  selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, ownerId: 'someone-else' }]);
  selectLimit.mockResolvedValueOnce([{ role: 'member' }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/chat-sessions', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(`/api/chat-sessions?projectId=${PROJECT_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns scoped list with X-Total-Count', async () => {
    authVerified();
    projectAccessAsMember();
    whereResults.push([{ n: 1 }]);
    selectOrderByOffset.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, userId: USER_ID, title: 't', source: 'web' },
    ]);
    const res = await buildApp().request(`/api/chat-sessions?projectId=${PROJECT_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Total-Count')).toBe('1');
    expect(await res.json()).toHaveLength(1);
  });
});

describe('POST /api/chat-sessions', () => {
  it('creates and stores under userId', async () => {
    authVerified();
    projectAccessAsMember();
    insertReturning.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, userId: USER_ID, source: 'web', messages: [] },
    ]);
    const res = await buildApp().request('/api/chat-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, title: 'hello' }),
    });
    expect(res.status).toBe(201);
  });
});

describe('GET /api/chat-sessions/:id', () => {
  it('forbids accessing another user’s session', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, userId: 'other-user', messages: [] },
    ]);
    const res = await buildApp().request(`/api/chat-sessions/${SESSION_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });

  it('404 when session missing', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request(`/api/chat-sessions/${SESSION_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/chat-sessions/:id/message', () => {
  it('appends message and broadcasts to user room', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        messages: [{ role: 'user', content: 'hi' }],
      },
    ]);
    projectAccessAsMember();
    updateReturning.mockResolvedValueOnce([
      { id: SESSION_ID, projectId: PROJECT_ID, userId: USER_ID, messages: [] },
    ]);
    const res = await buildApp().request(`/api/chat-sessions/${SESSION_ID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ content: 'hello world' }),
    });
    expect(res.status).toBe(200);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0]?.[0]).toBe(`user:${USER_ID}`);
  });

  it('400 on empty content', async () => {
    authVerified();
    const res = await buildApp().request(`/api/chat-sessions/${SESSION_ID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ content: '' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/chat-sessions/:id', () => {
  it('204 when owner of session', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: SESSION_ID, userId: USER_ID }]);
    const res = await buildApp().request(`/api/chat-sessions/${SESSION_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(204);
  });
});
