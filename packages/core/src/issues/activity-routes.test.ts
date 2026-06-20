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
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

// Resolve actors deterministically without touching the (mocked) db: a user
// ref → email, a device ref → name + agent marker. Keeps the db chain mock
// scoped to the activity query itself.
vi.mock('./actor-resolution.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./actor-resolution.js')>();
  return {
    ...actual,
    resolveActors: vi.fn(async (refs: { type: 'user' | 'device'; id: string }[]) => {
      const m = new Map();
      for (const r of refs) {
        m.set(
          actual.actorKey(r.type, r.id),
          r.type === 'user'
            ? { type: 'user', id: r.id, displayName: 'member@example.com', isAgent: false }
            : {
                type: 'device',
                id: r.id,
                displayName: 'Agent Device',
                isAgent: true,
                deviceId: r.id,
                ownerEmail: 'owner@example.com',
              },
        );
      }
      return m;
    }),
  };
});

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
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: null, orgRole: null });

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
      orgId: 'org-1',
      role: 'admin',
      orgRole: 'owner',
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
    const body = (await res.json()) as {
      items: Array<{ actorType: string; actor: { displayName: string; isAgent: boolean } | null }>;
      nextBefore: string | null;
    };
    expect(body.items).toHaveLength(2);
    expect(body.nextBefore).toBe(rows[1]?.createdAt.toISOString());
    // Each row carries a resolved actor while keeping the raw actorType.
    expect(body.items[0]?.actor).toEqual({
      type: 'user',
      id: USER_ID,
      displayName: 'member@example.com',
      isAgent: false,
    });
    expect(body.items[0]?.actorType).toBe('user');
  });

  it('nextBefore is null when page is not full', async () => {
    auth();
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'admin',
      orgRole: 'owner',
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
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: null, orgRole: null });
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
      orgId: 'org-1',
      role: 'admin',
      orgRole: 'owner',
    });
    const DEVICE_ID = '55555555-5555-4555-8555-555555555555';
    selectOrderByLimit.mockResolvedValueOnce([
      {
        id: ACT_ID,
        issueId: ISSUE_ID,
        action: 'comment.created',
        actorType: 'device',
        actorId: DEVICE_ID,
        payload: { commentId: 'c' },
        createdAt: new Date(),
      },
    ]);
    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/activity?type=comment`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ action: string; actor: { displayName: string; isAgent: boolean } | null }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.action).toBe('comment.created');
    // A device actor resolves to an agent label.
    expect(body.items[0]?.actor?.isAgent).toBe(true);
    expect(body.items[0]?.actor?.displayName).toBe('Agent Device');
  });
});
