import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectOrderBy = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const deleteWhere = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    delete: vi.fn(() => ({ where: deleteWhere })),
  },
}));

const projectAccess = vi.fn();
vi.mock('../lib/project-access.js', () => ({
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

selectOrderBy.mockImplementation(() => ({ limit: selectLimit }));

const { knowledgeEdgeRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/knowledge-edges', knowledgeEdgeRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const EDGE_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderBy.mockReset();
  selectOrderBy.mockImplementation(() => ({ limit: selectLimit }));
  insertReturning.mockReset();
  deleteWhere.mockReset();
  projectAccess.mockReset();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/knowledge-edges', () => {
  it('lists edges for a project', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'member' });
    selectLimit.mockResolvedValueOnce([
      { id: EDGE_ID, projectId: PROJECT_ID, subject: 's', predicate: 'p', object: 'o' },
    ]);
    const res = await buildApp().request(`/api/knowledge-edges?projectId=${PROJECT_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body[0]?.id).toBe(EDGE_ID);
  });
});

describe('POST /api/knowledge-edges', () => {
  it('403 for non-admin/owner', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: 'x', role: 'member' });
    const res = await buildApp().request('/api/knowledge-edges', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, subject: 's', predicate: 'p', object: 'o' }),
    });
    expect(res.status).toBe(403);
  });

  it('201 inserts edge', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'owner' });
    insertReturning.mockResolvedValueOnce([
      { id: EDGE_ID, projectId: PROJECT_ID, subject: 's', predicate: 'p', object: 'o' },
    ]);
    const res = await buildApp().request('/api/knowledge-edges', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, subject: 's', predicate: 'p', object: 'o' }),
    });
    expect(res.status).toBe(201);
  });
});

describe('DELETE /api/knowledge-edges/:id', () => {
  it('404 missing', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request(`/api/knowledge-edges/${EDGE_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
  });

  it('204 deletes for owner', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: EDGE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'owner' });
    deleteWhere.mockResolvedValueOnce(undefined);
    const res = await buildApp().request(`/api/knowledge-edges/${EDGE_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(204);
  });
});
