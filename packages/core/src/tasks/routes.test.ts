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
// tx.update().set().where() inside reorder transaction
const txUpdateWhere = vi.fn(() => Promise.resolve(undefined));
const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));
const transaction = vi.fn(async (cb: (tx: unknown) => unknown) =>
  cb({ update: vi.fn(() => ({ set: txUpdateSet })) }),
);

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: deleteWhere })),
    transaction: (cb: (tx: unknown) => unknown) => transaction(cb),
  },
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const { taskIssueRoutes, taskRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const hooksModule = await import('../pipeline/hooks.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/issues', taskIssueRoutes);
  app.route('/api/tasks', taskRoutes);
  app.onError(errorHandler);
  return app;
}

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderBy.mockReset();
  insertReturning.mockReset();
  updateReturning.mockReset();
  deleteWhere.mockReset();
  txUpdateWhere.mockReset();
  txUpdateWhere.mockImplementation(() => Promise.resolve(undefined));
  txUpdateSet.mockClear();
  transaction.mockClear();
  projectAccess.mockReset();
  hooksModule.hooks.reset();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('POST /api/issues/:id/tasks', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'a' }),
    });
    expect(res.status).toBe(401);
  });

  it('400 when title missing', async () => {
    authVerified();
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('404 when issue missing', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ title: 'a' }),
    });
    expect(res.status).toBe(404);
  });

  it('403 when not a project member', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: null, orgRole: null });
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ title: 'a' }),
    });
    expect(res.status).toBe(403);
  });

  it('201 inserts and emits taskCreated', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null });
    // sortOrder default lookup (no input.sortOrder) — empty issue
    selectLimit.mockResolvedValueOnce([{ max: null }]);
    insertReturning.mockResolvedValueOnce([
      { id: TASK_ID, issueId: ISSUE_ID, projectId: PROJECT_ID, title: 'do thing', status: 'backlog', sortOrder: 0 },
    ]);

    let emitted: unknown = null;
    hooksModule.hooks.on('taskCreated', (p) => {
      emitted = p;
    });

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ title: 'do thing' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; title: string };
    expect(body.id).toBe(TASK_ID);
    expect(emitted).toMatchObject({ taskId: TASK_ID, issueId: ISSUE_ID, projectId: PROJECT_ID });
    // insert was called with sortOrder=0 (max(-1)+1) since no rows existed
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 0 }));
  });

  it('defaults sortOrder to max+1 when other tasks exist', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null });
    selectLimit.mockResolvedValueOnce([{ max: 4 }]);
    insertReturning.mockResolvedValueOnce([
      { id: TASK_ID, issueId: ISSUE_ID, projectId: PROJECT_ID, title: 't', sortOrder: 5 },
    ]);

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ title: 't' }),
    });
    expect(res.status).toBe(201);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 5 }));
  });
});

describe('GET /api/issues/:id/tasks', () => {
  it('returns tasks ordered by createdAt asc', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null });
    selectOrderBy.mockResolvedValueOnce([
      { id: TASK_ID, title: 'first', issueId: ISSUE_ID, projectId: PROJECT_ID },
    ]);

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/tasks`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body[0]?.id).toBe(TASK_ID);
  });
});

describe('PATCH /api/tasks/:taskId', () => {
  it('updates status + emits taskUpdated', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: TASK_ID, issueId: ISSUE_ID, projectId: PROJECT_ID, status: 'backlog' },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null });
    updateReturning.mockResolvedValueOnce([
      { id: TASK_ID, issueId: ISSUE_ID, projectId: PROJECT_ID, status: 'in_progress' },
    ]);

    let emitted: { fields?: string[] } | null = null;
    hooksModule.hooks.on('taskUpdated', (p) => {
      emitted = p;
    });

    const res = await buildApp().request(`/api/tasks/${TASK_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ status: 'in_progress' }),
    });
    expect(res.status).toBe(200);
    expect((emitted as { fields?: string[] } | null)?.fields).toEqual(['status']);
  });
});

describe('DELETE /api/tasks/:taskId', () => {
  it('403 for non-member', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: TASK_ID, issueId: ISSUE_ID, projectId: PROJECT_ID },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: null, orgRole: null });
    const res = await buildApp().request(`/api/tasks/${TASK_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });

  it('204 for non-owner member + emits taskDeleted', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: TASK_ID, issueId: ISSUE_ID, projectId: PROJECT_ID },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null });
    deleteWhere.mockResolvedValueOnce(undefined);

    let emitted: unknown = null;
    hooksModule.hooks.on('taskDeleted', (p) => {
      emitted = p;
    });

    const res = await buildApp().request(`/api/tasks/${TASK_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(204);
    expect(emitted).toMatchObject({ taskId: TASK_ID });
  });
});

describe('POST /api/issues/:id/tasks/reorder', () => {
  const T1 = '55555555-5555-4555-8555-555555555555';
  const T2 = '66666666-6666-4666-8666-666666666666';
  const T3 = '77777777-7777-4777-8777-777777777777';
  const FOREIGN = '88888888-8888-4888-8888-888888888888';

  it('403 when not a project member', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: null, orgRole: null });

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/tasks/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ taskIds: [T1] }),
    });
    expect(res.status).toBe(403);
  });

  it('400 when taskIds count differs from existing', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null });
    selectOrderBy.mockResolvedValueOnce([
      { id: T1, sortOrder: 0 },
      { id: T2, sortOrder: 1 },
    ]);

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/tasks/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ taskIds: [T1] }),
    });
    expect(res.status).toBe(400);
  });

  it('400 when taskIds contains foreign id', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null });
    selectOrderBy.mockResolvedValueOnce([
      { id: T1, sortOrder: 0 },
      { id: T2, sortOrder: 1 },
    ]);

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/tasks/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ taskIds: [T1, FOREIGN] }),
    });
    expect(res.status).toBe(400);
  });

  it('204 reorders and emits taskUpdated for changed rows only', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null });
    selectOrderBy.mockResolvedValueOnce([
      { id: T1, sortOrder: 0 },
      { id: T2, sortOrder: 1 },
      { id: T3, sortOrder: 2 },
    ]);

    const emitted: Array<{ taskId: string; fields: string[] }> = [];
    hooksModule.hooks.on('taskUpdated', (p) => {
      emitted.push(p);
    });

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/tasks/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      // Reverse order: [T3,T2,T1] → T3 idx0 (was 2, changed), T2 idx1 (unchanged), T1 idx2 (was 0, changed)
      body: JSON.stringify({ taskIds: [T3, T2, T1] }),
    });
    expect(res.status).toBe(204);
    expect(emitted.map((e) => e.taskId).sort()).toEqual([T1, T3].sort());
    expect(emitted.every((e) => e.fields[0] === 'sortOrder')).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
