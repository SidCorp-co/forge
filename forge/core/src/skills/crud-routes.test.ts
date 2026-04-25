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
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const deleteWhere = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: deleteWhere })),
  },
}));

vi.mock('../jobs/enqueue.js', () => ({
  enqueueJob: vi.fn(async () => undefined),
}));

const { skillCrudRoutes } = await import('./crud-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/skills', skillCrudRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SKILL_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderBy.mockReset();
  insertReturning.mockReset();
  updateReturning.mockReset();
  deleteWhere.mockReset();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/skills', () => {
  it('lists global skills when no projectId', async () => {
    authVerified();
    selectOrderBy.mockResolvedValueOnce([
      { id: SKILL_ID, name: 's1', scope: 'global', skillMd: '...' },
    ]);
    const res = await buildApp().request('/api/skills?scope=global', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body[0]?.id).toBe(SKILL_ID);
  });
});

describe('POST /api/skills', () => {
  it('400 when isGlobal=false and no projectId', async () => {
    authVerified();
    const res = await buildApp().request('/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ name: 's', description: 'd', skillMd: 'md', isGlobal: false }),
    });
    expect(res.status).toBe(400);
  });

  it('403 when not owner/admin', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ ownerId: 'x' }]); // project lookup
    selectLimit.mockResolvedValueOnce([{ role: 'member' }]); // member lookup
    const res = await buildApp().request('/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        name: 's',
        description: 'd',
        skillMd: 'md',
        isGlobal: false,
        projectId: PROJECT_ID,
      }),
    });
    expect(res.status).toBe(403);
  });

  it('201 inserts project skill for owner', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ ownerId: USER_ID }]); // project
    selectLimit.mockResolvedValueOnce([{ role: 'owner' }]); // member
    insertReturning.mockResolvedValueOnce([
      {
        id: SKILL_ID,
        name: 's',
        description: 'd',
        scope: 'project',
        projectId: PROJECT_ID,
        skillMd: 'md',
      },
    ]);

    const res = await buildApp().request('/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        name: 's',
        description: 'd',
        skillMd: 'md',
        isGlobal: false,
        projectId: PROJECT_ID,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(SKILL_ID);
  });
});

describe('POST /api/skills/bulk-push', () => {
  it('403 for non-admin/owner', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ ownerId: 'x' }]);
    selectLimit.mockResolvedValueOnce([{ role: 'member' }]);

    const res = await buildApp().request('/api/skills/bulk-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        targets: ['dev'],
        projectId: PROJECT_ID,
      }),
    });
    expect(res.status).toBe(403);
  });

  it('400 missing targets', async () => {
    authVerified();
    const res = await buildApp().request('/api/skills/bulk-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ targets: [], projectId: PROJECT_ID }),
    });
    expect(res.status).toBe(400);
    void JOB_ID;
  });
});
