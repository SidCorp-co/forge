import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectFrom = vi.fn(() => ({ where: selectWhere, innerJoin: selectInnerJoin }));
const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
const selectOrderByLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectOrderByLimit }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

const projectAccess = vi.fn();
vi.mock('../lib/project-access.js', () => ({
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const { issueActivityRoutes, projectActivityRoutes } = await import('./activity-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/issues', issueActivityRoutes);
  app.route('/api/projects', projectActivityRoutes);
  app.onError(errorHandler);
  return app;
}

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const ACT_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderByLimit.mockReset();
  projectAccess.mockReset();
});

function auth(verified = true) {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: verified ? new Date() : null }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/issues/:id/activity', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/activity`);
    expect(res.status).toBe(401);
  });

  it('404 when issue missing', async () => {
    auth();
    selectLimit.mockResolvedValueOnce([]); // issue lookup empty

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/activity`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
  });

  it('403 when non-member', async () => {
    auth();
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]); // issue lookup
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: 'x', role: null });

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/activity`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });

  it('400 on invalid query param', async () => {
    auth();
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/activity?limit=abc`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });

  it('happy path returns items + nextBefore cursor when full page', async () => {
    auth();
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'owner',
    });
    const rows = Array.from({ length: 2 }, (_, i) => ({
      id: ACT_ID,
      issueId: ISSUE_ID,
      action: 'issue.updated',
      actorType: 'user',
      actorId: USER_ID,
      payload: {},
      createdAt: new Date(2026, 0, 10 - i),
    }));
    selectOrderByLimit.mockResolvedValueOnce(rows);

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/activity?limit=2`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextBefore: string | null };
    expect(body.items).toHaveLength(2);
    expect(body.nextBefore).toBe(rows[1].createdAt.toISOString());
  });

  it('nextBefore is null when page is not full', async () => {
    auth();
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'owner',
    });
    selectOrderByLimit.mockResolvedValueOnce([
      {
        id: ACT_ID,
        issueId: ISSUE_ID,
        action: 'issue.created',
        actorType: 'user',
        actorId: USER_ID,
        payload: {},
        createdAt: new Date(),
      },
    ]);

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/activity?limit=50`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    const body = (await res.json()) as { nextBefore: string | null };
    expect(body.nextBefore).toBeNull();
  });
});

describe('GET /api/projects/:id/activity', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/activity`);
    expect(res.status).toBe(401);
  });

  it('403 when non-member', async () => {
    auth();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: 'x', role: null });
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/activity`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });

  it('400 on invalid type', async () => {
    auth();
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/activity?type=bogus`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });

  it('happy path returns feed', async () => {
    auth();
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'owner',
    });
    selectOrderByLimit.mockResolvedValueOnce([
      {
        id: ACT_ID,
        issueId: ISSUE_ID,
        action: 'comment.created',
        actorType: 'user',
        actorId: USER_ID,
        payload: { commentId: 'c' },
        createdAt: new Date(),
      },
    ]);
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/activity?type=comment`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ action: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].action).toBe('comment.created');
  });
});
