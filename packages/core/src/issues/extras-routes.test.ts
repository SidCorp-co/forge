import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectOrderByLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectOrderByLimit }));
const selectInnerJoinWhere = vi.fn(() => ({ orderBy: selectOrderBy }));
const selectInnerJoin = vi.fn(() => ({ where: selectInnerJoinWhere }));
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere, innerJoin: selectInnerJoin }));
const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
  },
}));

const projectAccess = vi.fn();
vi.mock('../lib/project-access.js', () => ({
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const enqueueJobMock = vi.fn();
vi.mock('../jobs/enqueue.js', () => ({
  enqueueJob: (...args: unknown[]) => enqueueJobMock(...args),
}));

const { issueExtrasRoutes } = await import('./extras-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/issues', issueExtrasRoutes);
  app.onError(errorHandler);
  return app;
}

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderByLimit.mockReset();
  projectAccess.mockReset();
  enqueueJobMock.mockReset();
  insertReturning.mockReset();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('POST /api/issues/:id/enrich', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/enrich`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('404 when issue missing', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/enrich`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
  });

  it('403 when not a project member', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: 'other', role: null });
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/enrich`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });

  it('202 enqueues custom job and returns ids', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'member',
    });
    insertReturning.mockResolvedValueOnce([{ id: JOB_ID, status: 'queued' }]);
    enqueueJobMock.mockResolvedValueOnce(undefined);

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/enrich`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { issueId: string; jobId: string; status: string };
    expect(body).toEqual({ issueId: ISSUE_ID, jobId: JOB_ID, status: 'queued' });
    expect(enqueueJobMock).toHaveBeenCalledWith(JOB_ID);
  });
});

describe('GET /api/issues/pipeline-timing', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(
      `/api/issues/pipeline-timing?projectId=${PROJECT_ID}`,
    );
    expect(res.status).toBe(401);
  });

  it('400 when projectId is missing', async () => {
    authVerified();
    const res = await buildApp().request('/api/issues/pipeline-timing', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });

  it('403 when not a project member', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: 'other', role: null });
    const res = await buildApp().request(
      `/api/issues/pipeline-timing?projectId=${PROJECT_ID}`,
      { headers: { authorization: `Bearer ${await token()}` } },
    );
    expect(res.status).toBe(403);
  });

  it('aggregates dwell time from status-change activities', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'member',
    });

    const issueA = '55555555-5555-4555-8555-555555555555';
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-01T01:00:00Z'); // +1h
    const t2 = new Date('2026-01-01T03:00:00Z'); // +2h

    selectOrderByLimit.mockResolvedValueOnce([
      { issueId: issueA, payload: { from: 'open', to: 'confirmed' }, createdAt: t0 },
      { issueId: issueA, payload: { from: 'confirmed', to: 'approved' }, createdAt: t1 },
      { issueId: issueA, payload: { from: 'approved', to: 'in_progress' }, createdAt: t2 },
    ]);

    const res = await buildApp().request(
      `/api/issues/pipeline-timing?projectId=${PROJECT_ID}`,
      { headers: { authorization: `Bearer ${await token()}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projectId: string;
      stats: Array<{ status: string; sampleCount: number; avgMs: number }>;
    };
    expect(body.projectId).toBe(PROJECT_ID);
    const byStatus = Object.fromEntries(body.stats.map((s) => [s.status, s]));
    // 'open' dwelt for t1-t0 = 1h; 'confirmed' dwelt for t2-t1 = 2h.
    // 'approved' has no successor in the window so is not counted.
    expect(byStatus.open?.avgMs).toBe(60 * 60 * 1000);
    expect(byStatus.confirmed?.avgMs).toBe(2 * 60 * 60 * 1000);
    expect(byStatus.approved).toBeUndefined();
  });
});
