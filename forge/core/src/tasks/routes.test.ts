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

const projectAccess = vi.fn();
vi.mock('../lib/project-access.js', () => ({
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
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: 'x', role: null });
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
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'member' });
    insertReturning.mockResolvedValueOnce([
      { id: TASK_ID, issueId: ISSUE_ID, projectId: PROJECT_ID, title: 'do thing', status: 'backlog' },
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
  });
});

describe('GET /api/issues/:id/tasks', () => {
  it('returns tasks ordered by createdAt asc', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'member' });
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
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'member' });
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
    expect(emitted?.fields).toEqual(['status']);
  });
});

describe('DELETE /api/tasks/:taskId', () => {
  it('403 for non-owner', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: TASK_ID, issueId: ISSUE_ID, projectId: PROJECT_ID },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: 'other', role: 'member' });
    const res = await buildApp().request(`/api/tasks/${TASK_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });

  it('204 for owner + emits taskDeleted', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([
      { id: TASK_ID, issueId: ISSUE_ID, projectId: PROJECT_ID },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'owner' });
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
