import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectOffset = vi.fn(() => Promise.resolve([]));
const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    update: vi.fn(() => ({ set: updateSet })),
  },
}));

const projectAccess = vi.fn();
vi.mock('../lib/project-access.js', () => ({
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const { chatLogRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/chat-logs', chatLogRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const LOG_ID = '33333333-3333-4333-8333-333333333333';
const SLUG = 'my-project';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderBy.mockReset();
  selectOrderBy.mockImplementation(() => ({ limit: selectLimit }));
  updateReturning.mockReset();
  projectAccess.mockReset();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/chat-logs', () => {
  it('400 missing projectSlug', async () => {
    authVerified();
    const res = await buildApp().request('/api/chat-logs', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });

  it('404 unknown project', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([]); // resolveProjectIdBySlug
    const res = await buildApp().request(`/api/chat-logs?projectSlug=${SLUG}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/chat-logs/:id', () => {
  it('returns log + checks access', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: LOG_ID, projectSlug: SLUG, query: 'q', reply: 'r' },
    ]);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]); // resolveProjectIdBySlug
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'member' });

    const res = await buildApp().request(`/api/chat-logs/${LOG_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(LOG_ID);
  });
});

describe('PATCH /api/chat-logs/:id', () => {
  it('403 non-owner trying to update', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: LOG_ID, projectSlug: SLUG }]);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: 'x', role: 'member' });

    const res = await buildApp().request(`/api/chat-logs/${LOG_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ qaRating: 'bad' }),
    });
    expect(res.status).toBe(403);
  });

  it('200 owner can rate', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: LOG_ID, projectSlug: SLUG }]);
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'owner' });
    updateReturning.mockResolvedValueOnce([{ id: LOG_ID, qaRating: 'good' }]);

    const res = await buildApp().request(`/api/chat-logs/${LOG_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ qaRating: 'good' }),
    });
    expect(res.status).toBe(200);
  });
});

// silence unused import warnings
void selectOffset;
