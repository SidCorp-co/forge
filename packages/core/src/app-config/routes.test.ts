import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
// loadProjectAccess (lib/authz) runs select().from().leftJoin().leftJoin()
// .where().limit() — route the join chain back into the same where/limit FIFO.
const selectLeftJoin = vi.fn((): Record<string, unknown> => ({
  leftJoin: selectLeftJoin,
  where: selectWhere,
}));
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));
const insertReturning = vi.fn();
const insertOnConflictDoUpdate = vi.fn(() => ({ returning: insertReturning }));
const insertValues = vi.fn(() => ({
  onConflictDoUpdate: insertOnConflictDoUpdate,
  returning: insertReturning,
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
  },
}));

const { appConfigRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/app-config', appConfigRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const CONFIG_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  insertReturning.mockReset();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

function projectAccessAsMember() {
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
}

function projectAccessAsOwner() {
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: 'owner' }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/app-config/:projectId', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(`/api/app-config/${PROJECT_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns null when no row exists', async () => {
    authVerified();
    projectAccessAsMember();
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request(`/api/app-config/${PROJECT_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('returns row when present', async () => {
    authVerified();
    projectAccessAsMember();
    selectLimit.mockResolvedValueOnce([
      { id: CONFIG_ID, projectId: PROJECT_ID, retrievalTopK: 10 },
    ]);
    const res = await buildApp().request(`/api/app-config/${PROJECT_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { projectId: string };
    expect(json.projectId).toBe(PROJECT_ID);
  });

  it('403 when not a member and not owner', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]);
    const res = await buildApp().request(`/api/app-config/${PROJECT_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/app-config/:projectId', () => {
  it('upserts and returns 200', async () => {
    authVerified();
    projectAccessAsOwner();
    insertReturning.mockResolvedValueOnce([
      { id: CONFIG_ID, projectId: PROJECT_ID, chatProviderId: 'litellm', retrievalTopK: 5 },
    ]);
    const res = await buildApp().request(`/api/app-config/${PROJECT_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ chatProviderId: 'litellm', retrievalTopK: 5 }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { chatProviderId: string };
    expect(json.chatProviderId).toBe('litellm');
  });

  it('400 on invalid payload (extra key)', async () => {
    authVerified();
    const res = await buildApp().request(`/api/app-config/${PROJECT_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ unknownField: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('403 when only a regular member', async () => {
    authVerified();
    projectAccessAsMember();
    const res = await buildApp().request(`/api/app-config/${PROJECT_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ retrievalTopK: 5 }),
    });
    expect(res.status).toBe(403);
  });
});
