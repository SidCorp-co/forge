import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

// DB mock — select chain: select→from→where→{orderBy,limit}
// update chain: update→set→where→returning
const selectLimit = vi.fn();
const selectOrderBy = vi.fn((_p: unknown) => ({ limit: selectLimit }));
const selectWhere = vi.fn((_p: unknown) => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectFrom = vi.fn((_p: unknown) => ({ where: selectWhere }));

const updateReturning = vi.fn();
const updateWhere = vi.fn((_p: unknown) => ({ returning: updateReturning }));
const updateSet = vi.fn((_p: unknown) => ({ where: updateWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    update: vi.fn(() => ({ set: updateSet })),
  },
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const { feedbackReportRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/feedback-reports', feedbackReportRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const REPORT_ID = '44444444-4444-4444-8444-444444444444';

const NOW = new Date('2026-06-23T10:00:00Z');

const MOCK_REPORT = {
  id: REPORT_ID,
  kind: 'friction',
  severity: 'low',
  target: 'skill',
  targetRef: 'some-skill',
  summary: 'Test friction summary',
  detail: null,
  suggestion: null,
  signalKey: 'self_report:skill:some-skill:friction',
  sessionId: null,
  reviewedAt: null,
  createdAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
});

/** Sets up the email-verify select call: first selectLimit resolves with a verified user. */
function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/feedback-reports', () => {
  it('requires auth', async () => {
    const app = buildApp();
    const res = await app.request(`/api/feedback-reports?projectId=${PROJECT_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 400 without projectId', async () => {
    authVerified();
    const app = buildApp();
    const res = await app.request('/api/feedback-reports', {
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });

  it('returns 403 for non-member', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ role: null });
    const app = buildApp();
    const res = await app.request(`/api/feedback-reports?projectId=${PROJECT_ID}`, {
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });

  it('returns list for member', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ role: 'viewer' });
    // data query: where().orderBy().limit() → rows
    selectLimit.mockResolvedValueOnce([MOCK_REPORT]);

    const app = buildApp();
    const res = await app.request(`/api/feedback-reports?projectId=${PROJECT_ID}`, {
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; kind: string; createdAt: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body.at(0)?.id).toBe(REPORT_ID);
    expect(body.at(0)?.kind).toBe('friction');
    expect(typeof body.at(0)?.createdAt).toBe('string');
  });

  it('passes kind filter', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ role: 'viewer' });
    selectLimit.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await app.request(
      `/api/feedback-reports?projectId=${PROJECT_ID}&kind=friction`,
      { headers: { Authorization: `Bearer ${await token()}` } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe('POST /api/feedback-reports/:id/reviewed', () => {
  it('requires auth', async () => {
    const app = buildApp();
    const res = await app.request(`/api/feedback-reports/${REPORT_ID}/reviewed`, {
      method: 'POST',
      body: JSON.stringify({ reviewed: true }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 when report not found', async () => {
    authVerified();
    // report lookup returns empty
    selectLimit.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await app.request(`/api/feedback-reports/${REPORT_ID}/reviewed`, {
      method: 'POST',
      body: JSON.stringify({ reviewed: true }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await token()}`,
      },
    });
    expect(res.status).toBe(404);
  });

  it('marks reviewed and returns updated row', async () => {
    authVerified();
    // report lookup returns the existing row
    selectLimit.mockResolvedValueOnce([{ id: REPORT_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ role: 'member' });
    updateReturning.mockResolvedValueOnce([{ id: REPORT_ID, reviewedAt: NOW }]);

    const app = buildApp();
    const res = await app.request(`/api/feedback-reports/${REPORT_ID}/reviewed`, {
      method: 'POST',
      body: JSON.stringify({ reviewed: true }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await token()}`,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; reviewedAt: string };
    expect(body.id).toBe(REPORT_ID);
    expect(body.reviewedAt).toBe(NOW.toISOString());
  });

  it('unmarks reviewed (clears reviewedAt)', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: REPORT_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ role: 'member' });
    updateReturning.mockResolvedValueOnce([{ id: REPORT_ID, reviewedAt: null }]);

    const app = buildApp();
    const res = await app.request(`/api/feedback-reports/${REPORT_ID}/reviewed`, {
      method: 'POST',
      body: JSON.stringify({ reviewed: false }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await token()}`,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reviewedAt: string | null };
    expect(body.reviewedAt).toBeNull();
  });
});
