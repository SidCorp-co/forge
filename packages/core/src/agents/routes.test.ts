import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const whereResults: unknown[][] = [];
const selectLimit = vi.fn();
const selectOrderBy = vi.fn();
const selectWhere = vi.fn(() => ({
  limit: selectLimit,
  orderBy: selectOrderBy,
  // biome-ignore lint/suspicious/noThenProperty: drizzle chains resolve via await — the mock must be thenable
  then: (cb: (v: unknown) => unknown) => {
    const result = whereResults.shift() ?? [];
    return Promise.resolve(result).then(cb);
  },
}));
// loadProjectAccess (lib/authz) runs select().from().leftJoin().leftJoin()
// .where().limit() — route the join chain back into the same where/limit FIFO.
const selectLeftJoin = vi.fn((): Record<string, unknown> => ({
  leftJoin: selectLeftJoin,
  where: selectWhere,
}));
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));
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

const { agentRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/agents', agentRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderBy.mockReset();
  insertReturning.mockReset();
  updateReturning.mockReset();
  whereResults.length = 0;
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

function projectAccessAsMember() {
  // loadProjectAccess: first .limit() = project lookup, second = membership
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
}

function projectAccessAsOwner() {
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: 'owner' }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/agents', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(`/api/agents?projectId=${PROJECT_ID}`);
    expect(res.status).toBe(401);
  });

  it('400 without projectId', async () => {
    authVerified();
    const res = await buildApp().request('/api/agents', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });

  it('returns scoped list with X-Total-Count', async () => {
    authVerified();
    projectAccessAsMember();
    whereResults.push([{ n: 1 }]);
    selectOrderBy.mockResolvedValueOnce([
      { id: AGENT_ID, projectId: PROJECT_ID, name: 'a', type: 'reviewer', enabled: false },
    ]);
    const res = await buildApp().request(`/api/agents?projectId=${PROJECT_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Total-Count')).toBe('1');
    expect(await res.json()).toHaveLength(1);
  });

  it('403 when not a member and not owner', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]);
    const res = await buildApp().request(`/api/agents?projectId=${PROJECT_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/agents', () => {
  it('creates and returns 201', async () => {
    authVerified();
    projectAccessAsOwner();
    insertReturning.mockResolvedValueOnce([
      { id: AGENT_ID, projectId: PROJECT_ID, name: 'a', type: 'reviewer', enabled: false },
    ]);
    const res = await buildApp().request('/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, name: 'a', type: 'reviewer' }),
    });
    expect(res.status).toBe(201);
  });

  it('400 on bad payload', async () => {
    authVerified();
    const res = await buildApp().request('/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/agents/:id', () => {
  it('updates and returns row', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: AGENT_ID, projectId: PROJECT_ID, name: 'a', type: 'reviewer', enabled: false },
    ]);
    projectAccessAsOwner();
    updateReturning.mockResolvedValueOnce([
      { id: AGENT_ID, projectId: PROJECT_ID, name: 'b', type: 'reviewer', enabled: true },
    ]);
    const res = await buildApp().request(`/api/agents/${AGENT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ name: 'b', enabled: true }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { name: string };
    expect(json.name).toBe('b');
  });

  it('404 when agent not found', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request(`/api/agents/${AGENT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ name: 'b' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/agents/:id', () => {
  it('204 when owner', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: AGENT_ID, projectId: PROJECT_ID }]);
    projectAccessAsOwner();
    const res = await buildApp().request(`/api/agents/${AGENT_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(204);
  });

  it('403 when only a regular member', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: AGENT_ID, projectId: PROJECT_ID }]);
    projectAccessAsMember();
    const res = await buildApp().request(`/api/agents/${AGENT_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });
});
