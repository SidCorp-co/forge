import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';
const TEST_PEPPER = 'y'.repeat(32);

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, DEVICE_TOKEN_PEPPER: TEST_PEPPER, NODE_ENV: 'test' },
}));

const whereResults: unknown[][] = [];
const selectLimit = vi.fn();
const selectOrderByOffset = vi.fn();
const selectOrderByLimit = vi.fn(() => ({ offset: selectOrderByOffset }));
const selectOrderBy = vi.fn(() => ({ limit: selectOrderByLimit, offset: selectOrderByOffset }));
const selectWhere = vi.fn(() => ({
  limit: selectLimit,
  orderBy: selectOrderBy,
  // biome-ignore lint/suspicious/noThenProperty: drizzle query builder is awaitable
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
const insertOnConflictReturning = vi.fn();
const insertOnConflictDoNothing = vi.fn(() => ({
  returning: insertOnConflictReturning,
  // biome-ignore lint/suspicious/noThenProperty: drizzle query builder is awaitable
  then: (cb: (v: unknown) => unknown) => Promise.resolve(undefined).then(cb),
}));
const insertValues = vi.fn(() => ({
  returning: insertReturning,
  onConflictDoNothing: insertOnConflictDoNothing,
}));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({
  returning: updateReturning,
  // biome-ignore lint/suspicious/noThenProperty: drizzle query builder is awaitable
  then: (cb: (v: unknown) => unknown) => Promise.resolve(undefined).then(cb),
}));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const deleteReturning = vi.fn();
const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: deleteWhere })),
  },
}));

const indexMemoryMock = vi.fn(() => Promise.resolve());
const deleteMemoryMock = vi.fn(() => Promise.resolve(0));
vi.mock('../memory/indexer.js', () => ({
  indexMemory: indexMemoryMock,
  indexMemoryBestEffort: indexMemoryMock,
  deleteMemory: deleteMemoryMock,
}));

// /run + /respond import the spawner; routes-crud tests don't exercise those
// endpoints but the module is loaded for its side effects. Stub it so we
// don't transitively pull in pg-boss / DATABASE_URL just to register routes.
const spawnMock = vi.fn(async (..._args: unknown[]) => ({ ok: true, jobId: 'pm-1' }) as const);
vi.mock('./spawner.js', () => ({
  spawnPmSession: (...args: unknown[]) => spawnMock(...(args as [unknown])),
}));

vi.mock('../pipeline/hooks.js', () => ({
  hooks: { emit: vi.fn(async () => {}) },
}));

const { pmRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', pmRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '99999999-9999-4999-8999-999999999999';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const POLICY_ID = '33333333-3333-4333-8333-333333333333';
const DECISION_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderByOffset.mockReset();
  insertReturning.mockReset();
  insertOnConflictReturning.mockReset();
  updateReturning.mockReset();
  deleteReturning.mockReset();
  whereResults.length = 0;
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

function projectAccessAs(role: 'owner' | 'admin' | 'member' | null) {
  // Single joined loadProjectAccess row. Legacy 'owner' maps to org owner
  // (implicit project admin) under org-level authz.
  selectLimit.mockResolvedValueOnce([
    role === 'owner'
      ? { orgId: 'org-1', memberRole: null, orgRole: 'owner' }
      : { orgId: 'org-1', memberRole: role, orgRole: null },
  ]);
}

function projectAccessAsOwner() {
  projectAccessAs('owner');
}

async function token() {
  return signUserToken(USER_ID);
}

const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));

describe('GET /api/projects/:projectId/pm/config', () => {
  it('returns existing row', async () => {
    authVerified();
    projectAccessAs('member');
    selectLimit.mockResolvedValueOnce([
      { id: 'cfg', projectId: PROJECT_ID, enabled: false, maxRunsPerHour: 6 },
    ]);
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/pm/config`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ projectId: PROJECT_ID });
  });

  it('lazy-creates default row when missing', async () => {
    authVerified();
    projectAccessAs('member');
    selectLimit.mockResolvedValueOnce([]); // no existing row
    insertOnConflictReturning.mockResolvedValueOnce([
      { id: 'cfg', projectId: PROJECT_ID, enabled: false, maxRunsPerHour: 6 },
    ]);
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/pm/config`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(insertOnConflictReturning).toHaveBeenCalled();
  });

  it('403 for non-member', async () => {
    authVerified();
    projectAccessAs(null);
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/pm/config`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/projects/:projectId/pm/config', () => {
  it('rejects non-admin member with 403', async () => {
    authVerified();
    projectAccessAs('member');
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/pm/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
  });

  it('admin can update partial fields', async () => {
    authVerified();
    projectAccessAs('admin');
    updateReturning.mockResolvedValueOnce([
      { id: 'cfg', projectId: PROJECT_ID, enabled: true, maxRunsPerHour: 12 },
    ]);
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/pm/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ enabled: true, maxRunsPerHour: 12 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, maxRunsPerHour: 12 });
  });

  it('owner can update', async () => {
    authVerified();
    projectAccessAsOwner();
    updateReturning.mockResolvedValueOnce([
      { id: 'cfg', projectId: PROJECT_ID, enabled: true, maxRunsPerHour: 6 },
    ]);
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/pm/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects unknown keys via .strict()', async () => {
    authVerified();
    projectAccessAs('admin');
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/pm/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ enabled: true, sneaky: 'value' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/projects/:projectId/pm/policies', () => {
  it('owner creates and queues indexMemory', async () => {
    authVerified();
    projectAccessAsOwner();
    insertReturning.mockResolvedValueOnce([
      {
        id: POLICY_ID,
        projectId: PROJECT_ID,
        name: 'p',
        body: 'rule body',
        enabled: true,
        priority: 0,
      },
    ]);
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/pm/policies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ name: 'p', body: 'rule body' }),
    });
    expect(res.status).toBe(201);
    await flushMicrotasks();
    expect(indexMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'policy', sourceRef: POLICY_ID, text: 'rule body' }),
    );
  });

  it('rejects non-admin member', async () => {
    authVerified();
    projectAccessAs('member');
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/pm/policies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ name: 'p', body: 'rule body' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/projects/:projectId/pm/policies/:id', () => {
  it('admin deletes and queues deleteMemory', async () => {
    authVerified();
    projectAccessAs('admin');
    deleteReturning.mockResolvedValueOnce([{ id: POLICY_ID }]);
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/pm/policies/${POLICY_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(204);
    await flushMicrotasks();
    expect(deleteMemoryMock).toHaveBeenCalledWith(PROJECT_ID, 'policy', POLICY_ID);
  });

  it('rejects non-admin member', async () => {
    authVerified();
    projectAccessAs('member');
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/pm/policies/${POLICY_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });

  it('404 when policy does not belong to project', async () => {
    authVerified();
    projectAccessAs('admin');
    deleteReturning.mockResolvedValueOnce([]);
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/pm/policies/${POLICY_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/projects/:projectId/pm/decisions', () => {
  it('member can read paginated list with X-Total-Count', async () => {
    authVerified();
    projectAccessAs('member');
    whereResults.push([{ n: 3 }]);
    selectOrderByOffset.mockResolvedValueOnce([
      { id: DECISION_ID, projectId: PROJECT_ID, cause: 'job-failed', summary: 's' },
    ]);
    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/pm/decisions?page=1&pageSize=10`,
      { headers: { authorization: `Bearer ${await token()}` } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Total-Count')).toBe('3');
  });

  it('403 for non-member', async () => {
    authVerified();
    projectAccessAs(null);
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/pm/decisions`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });
});
