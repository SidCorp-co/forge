import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

// DB mock — select chain: select→from→where→{orderBy,limit}; fleet path adds
// an intervening leftJoin(projects): select→from→leftJoin→where→{orderBy,limit}
// update chain: update→set→where→returning
const selectLimit = vi.fn();
const selectOrderBy = vi.fn((_p: unknown) => ({ limit: selectLimit }));
const selectWhere = vi.fn((_p: unknown) => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectLeftJoin = vi.fn((_p: unknown) => ({ where: selectWhere }));
const selectFrom = vi.fn((_p: unknown) => ({ where: selectWhere, leftJoin: selectLeftJoin }));

const updateReturning = vi.fn();
const updateWhere = vi.fn((_p: unknown) => ({ returning: updateReturning }));
const updateSet = vi.fn((_p: unknown) => ({ where: updateWhere }));

// loadVisibleProjectIds chain: selectDistinct({id}).from().leftJoin().leftJoin().where()
const selectDistinctImpl = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    selectDistinct: (...a: unknown[]) => selectDistinctImpl(...a),
    update: vi.fn(() => ({ set: updateSet })),
  },
}));

function mockVisibleProjectIds(ids: string[]) {
  selectDistinctImpl.mockImplementationOnce(() => ({
    from: () => ({
      leftJoin: () => ({
        leftJoin: () => ({
          where: () => Promise.resolve(ids.map((id) => ({ id }))),
        }),
      }),
    }),
  }));
}

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

// Spies on the real isNull/isNotNull so tests can assert which condition the
// reviewed filter actually built, instead of relying on the mocked row count
// (which returns rows regardless of the WHERE clause).
const isNullSpy = vi.fn();
const isNotNullSpy = vi.fn();
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    isNull: (...args: [unknown]) => {
      isNullSpy(...args);
      return actual.isNull(...args);
    },
    isNotNull: (...args: [unknown]) => {
      isNotNullSpy(...args);
      return actual.isNotNull(...args);
    },
  };
});

const { feedbackReportRoutes } = await import('./routes.js');
const { feedbackReports } = await import('../db/schema.js');
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
    const res = await app.request(`/api/feedback-reports?projectId=${PROJECT_ID}&kind=friction`, {
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('scope=all: rolls up reports across every visible project, carrying projectId/projectSlug', async () => {
    authVerified();
    const PROJECT_ID_2 = '55555555-5555-4555-8555-555555555555';
    mockVisibleProjectIds([PROJECT_ID, PROJECT_ID_2]);
    selectLimit.mockResolvedValueOnce([
      { ...MOCK_REPORT, projectId: PROJECT_ID, projectSlug: 'forge-dev' },
      {
        ...MOCK_REPORT,
        id: '66666666-6666-4666-8666-666666666666',
        projectId: PROJECT_ID_2,
        projectSlug: 'other-proj',
      },
    ]);

    const app = buildApp();
    const res = await app.request('/api/feedback-reports?scope=all', {
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ projectId: string; projectSlug: string }>;
    expect(body).toHaveLength(2);
    expect(body.map((r) => r.projectSlug).sort()).toEqual(['forge-dev', 'other-proj']);
    // No project-membership call is made for the fleet path — bounding comes
    // from loadVisibleProjectIds, not loadProjectAccess.
    expect(projectAccess).not.toHaveBeenCalled();
  });

  it('scope=all: returns an empty list (no data query) when the caller has no visible projects', async () => {
    authVerified();
    mockVisibleProjectIds([]);

    const app = buildApp();
    const res = await app.request('/api/feedback-reports?scope=all', {
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    // Only the auth email-verify check hits selectLimit — no data query runs.
    expect(selectLimit).toHaveBeenCalledTimes(1);
  });

  it('reviewed=false filters to unreviewed reports (single project)', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ role: 'viewer' });
    selectLimit.mockResolvedValueOnce([MOCK_REPORT]);

    const app = buildApp();
    const res = await app.request(`/api/feedback-reports?projectId=${PROJECT_ID}&reviewed=false`, {
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body).toHaveLength(1);
    // Guards against z.coerce.boolean() regressing: Boolean('false') === true
    // would silently build isNotNull(reviewedAt) here instead.
    expect(isNullSpy).toHaveBeenCalledWith(feedbackReports.reviewedAt);
    expect(isNotNullSpy).not.toHaveBeenCalled();
  });

  it('reviewed=true filters to reviewed reports (single project)', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ role: 'viewer' });
    selectLimit.mockResolvedValueOnce([MOCK_REPORT]);

    const app = buildApp();
    const res = await app.request(`/api/feedback-reports?projectId=${PROJECT_ID}&reviewed=true`, {
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(isNotNullSpy).toHaveBeenCalledWith(feedbackReports.reviewedAt);
    expect(isNullSpy).not.toHaveBeenCalled();
  });

  it('scope=all&reviewed=false filters to unreviewed reports (fleet)', async () => {
    authVerified();
    mockVisibleProjectIds([PROJECT_ID]);
    selectLimit.mockResolvedValueOnce([
      { ...MOCK_REPORT, projectId: PROJECT_ID, projectSlug: 'forge-dev' },
    ]);

    const app = buildApp();
    const res = await app.request('/api/feedback-reports?scope=all&reviewed=false', {
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(isNullSpy).toHaveBeenCalledWith(feedbackReports.reviewedAt);
    expect(isNotNullSpy).not.toHaveBeenCalled();
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

  it('linkedIssueId stamps reviewedAt and the link atomically', async () => {
    const LINKED_ISSUE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: REPORT_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ role: 'member' });
    selectLimit.mockResolvedValueOnce([{ id: LINKED_ISSUE_ID }]); // same-project issue lookup
    updateReturning.mockResolvedValueOnce([
      { id: REPORT_ID, reviewedAt: NOW, linkedIssueId: LINKED_ISSUE_ID },
    ]);

    const app = buildApp();
    const res = await app.request(`/api/feedback-reports/${REPORT_ID}/reviewed`, {
      method: 'POST',
      body: JSON.stringify({ reviewed: true, linkedIssueId: LINKED_ISSUE_ID }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await token()}`,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { linkedIssueId: string | null };
    expect(body.linkedIssueId).toBe(LINKED_ISSUE_ID);
  });

  it('linkedIssueId in a different project returns 404 and stamps nothing', async () => {
    const OTHER_ISSUE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: REPORT_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ role: 'member' });
    selectLimit.mockResolvedValueOnce([]); // no issue found for this project

    const app = buildApp();
    const res = await app.request(`/api/feedback-reports/${REPORT_ID}/reviewed`, {
      method: 'POST',
      body: JSON.stringify({ reviewed: true, linkedIssueId: OTHER_ISSUE_ID }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await token()}`,
      },
    });
    expect(res.status).toBe(404);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('review without linkedIssueId still works (back-compat)', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: REPORT_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ role: 'member' });
    updateReturning.mockResolvedValueOnce([
      { id: REPORT_ID, reviewedAt: NOW, linkedIssueId: null },
    ]);

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
    // No linkedIssueId in the request → key omitted from the update set
    // (existing link, if any, is left untouched).
    expect(updateSet).toHaveBeenCalledWith({ reviewedAt: expect.any(Date) });
  });
});
