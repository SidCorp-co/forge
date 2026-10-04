import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const USER_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const REPORT_ID = '44444444-4444-4444-8444-444444444444';

vi.mock('../middleware/auth.js', () => ({
  requireAuth:
    () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
      c.set('userId', USER_ID);
      await next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const readReport = vi.fn();
const stampReviewed = vi.fn();
vi.mock('./service.js', () => ({
  readReport,
  stampReviewed,
  issueVisibleIn: vi.fn(async () => true),
  listReports: vi.fn(async () => []),
  reportViews: vi.fn(async () => []),
}));

vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: vi.fn(async () => ({ projectId: PROJECT_ID, role: 'member' })),
  assertProjectRole: vi.fn(),
  loadVisibleProjectIds: vi.fn(async () => []),
}));

const { agentReportRoutes, feedbackReportsAliasRoutes, FEEDBACK_REPORTS_ALIAS_DEPRECATION } =
  await import('./routes.js');

function buildApp() {
  const app = new Hono();
  app.route('/api/agent-reports', agentReportRoutes);
  app.route('/api/feedback-reports', feedbackReportsAliasRoutes);
  return app;
}

/** One `POST /:id/reviewed` that finds the report and stamps it. */
function queueReviewed(): void {
  readReport.mockResolvedValueOnce({ id: REPORT_ID, projectId: PROJECT_ID });
  stampReviewed.mockResolvedValueOnce({
    ok: true,
    rows: [{ id: REPORT_ID, reviewedAt: null, linkedIssueId: null }],
  });
}

const reviewed = (base: string) =>
  buildApp().request(`${base}/${REPORT_ID}/reviewed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reviewed: false }),
  });

beforeEach(() => {
  readReport.mockReset();
  stampReviewed.mockReset();
});

describe('/api/agent-reports and its /api/feedback-reports alias', () => {
  it('answers on the new mount with no deprecation anywhere', async () => {
    queueReviewed();
    const res = await reviewed('/api/agent-reports');
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBeNull();
    expect(await res.json()).toEqual({ id: REPORT_ID, reviewedAt: null, linkedIssueId: null });
  });

  it('answers on the old mount with the same body plus a deprecation field and headers', async () => {
    queueReviewed();
    const res = await reviewed('/api/feedback-reports');
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    expect(res.headers.get('Link')).toBe('</api/agent-reports>; rel="successor-version"');
    expect(await res.json()).toEqual({
      id: REPORT_ID,
      reviewedAt: null,
      linkedIssueId: null,
      deprecation: FEEDBACK_REPORTS_ALIAS_DEPRECATION,
    });
  });

  it('answers a refused review in the one 422 envelope, naming the item the report became', async () => {
    readReport.mockResolvedValueOnce({ id: REPORT_ID, projectId: PROJECT_ID });
    const refusal = { code: 'AGENT_REPORT_PROMOTED', path: '/reviewed', detail: 'became FB-7' };
    stampReviewed.mockResolvedValueOnce({ ok: false, refusals: [refusal] });
    const res = await reviewed('/api/agent-reports');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { code: 'AGENT_REPORT_PROMOTED', refusals: [refusal] },
    });
    expect(stampReviewed).toHaveBeenCalledWith(expect.any(Array), {
      reviewed: false,
      linkedIssueId: null,
    });
  });

  it('keeps a list an array on the old mount and says it is deprecated in the headers', async () => {
    const res = await buildApp().request('/api/feedback-reports?scope=all');
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    expect(await res.json()).toEqual([]);
  });
});
