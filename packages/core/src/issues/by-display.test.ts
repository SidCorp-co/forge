import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const innerJoinWhere = vi.fn();
const selectInnerJoin = vi.fn(() => ({ where: innerJoinWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, innerJoin: selectInnerJoin }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

const projectAccess = vi.fn();
vi.mock('../lib/project-access.js', () => ({
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

vi.mock('../comments/routes.js', () => ({
  registerIssueCommentRoutes: () => {},
}));

const { issueProjectRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', issueProjectRoutes);
  app.onError(errorHandler);
  return app;
}

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  innerJoinWhere.mockReset();
  projectAccess.mockReset();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/projects/:id/issues/by-display/:displayId', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/issues/by-display/ISS-1`,
    );
    expect(res.status).toBe(401);
  });

  it('400 on malformed displayId', async () => {
    authVerified();
    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/issues/by-display/NOT-VALID`,
      { headers: { authorization: `Bearer ${await token()}` } },
    );
    expect(res.status).toBe(400);
  });

  it('403 when non-member', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: 'someone-else',
      role: null,
    });
    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/issues/by-display/ISS-1`,
      { headers: { authorization: `Bearer ${await token()}` } },
    );
    expect(res.status).toBe(403);
  });

  it('404 when displayId not found in project', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'owner',
    });
    selectLimit.mockResolvedValueOnce([]); // issue lookup empty

    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/issues/by-display/ISS-999`,
      { headers: { authorization: `Bearer ${await token()}` } },
    );
    expect(res.status).toBe(404);
  });

  it('200 returns issue + labels + empty comments/activity', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'owner',
    });
    selectLimit.mockResolvedValueOnce([
      {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        issSeq: 7,
        title: 'hi',
        description: null,
        status: 'open',
        priority: 'medium',
        category: null,
        assigneeId: null,
        createdById: USER_ID,
        parentIssueId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    innerJoinWhere.mockResolvedValueOnce([]); // labels query result

    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/issues/by-display/ISS-7`,
      { headers: { authorization: `Bearer ${await token()}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      displayId: string;
      labels: unknown[];
      comments: unknown[];
      activity: unknown[];
    };
    expect(body.id).toBe(ISSUE_ID);
    expect(body.displayId).toBe('ISS-7');
    expect(body.labels).toEqual([]);
    expect(body.comments).toEqual([]);
    expect(body.activity).toEqual([]);
  });
});
