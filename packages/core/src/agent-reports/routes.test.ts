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
  restActor: (c: { get: (k: string) => string }) => ({
    type: 'user',
    id: c.get('userId'),
    agency: 'human',
  }),
}));

const readReport = vi.fn();
const triageReports = vi.fn();
const visibleIssue = vi.fn();
vi.mock('./service.js', () => ({
  readReport,
  triageReports,
  visibleIssue,
  announceFiled: vi.fn(async () => undefined),
  listReports: vi.fn(async () => []),
  reportViews: vi.fn(async () => []),
}));

vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: vi.fn(async () => ({ projectId: PROJECT_ID, role: 'member' })),
  assertProjectRole: vi.fn(),
  loadVisibleProjectIds: vi.fn(async () => [PROJECT_ID]),
}));

const { agentReportRoutes, feedbackReportsAliasRoutes, FEEDBACK_REPORTS_ALIAS_DEPRECATION } =
  await import('./routes.js');

function buildApp() {
  const app = new Hono();
  app.route('/api/agent-reports', agentReportRoutes);
  app.route('/api/feedback-reports', feedbackReportsAliasRoutes);
  return app;
}

const post = (path: string, body: unknown) =>
  buildApp().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const EFFECT = { act: 'reopen', triage: 'new', reports: [REPORT_ID], issue: null, untouched: [] };

beforeEach(() => {
  readReport.mockReset();
  triageReports.mockReset();
  visibleIssue.mockReset();
});

describe('POST /api/agent-reports/:id/triage', () => {
  it('runs the one triage write and answers its effect, with no deprecation on the new mount', async () => {
    readReport.mockResolvedValueOnce({ id: REPORT_ID, projectId: PROJECT_ID });
    triageReports.mockResolvedValueOnce({ ok: true, effect: EFFECT, createdIssueId: null });
    const res = await post(`/api/agent-reports/${REPORT_ID}/triage`, { act: 'reopen' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBeNull();
    expect(await res.json()).toEqual({ effect: EFFECT });
    expect(triageReports).toHaveBeenCalledWith(
      expect.objectContaining({
        bulk: false,
        act: { act: 'reopen' },
        actor: { userId: USER_ID, agency: 'human' },
        linkIssue: null,
      }),
    );
  });

  it('answers a refusal in the one 422 envelope', async () => {
    readReport.mockResolvedValueOnce({ id: REPORT_ID, projectId: PROJECT_ID });
    const refusal = {
      code: 'AGENT_REPORT_DISMISS_REASON_REQUIRED',
      path: '/reason',
      detail: 'why',
    };
    triageReports.mockResolvedValueOnce({ ok: false, refusals: [refusal] });
    const res = await post(`/api/agent-reports/${REPORT_ID}/triage`, { act: 'dismiss' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { code: 'AGENT_REPORT_DISMISS_REASON_REQUIRED', refusals: [refusal] },
    });
  });

  it('refuses a file naming both an issue and createIssue, or neither, by its shape', async () => {
    for (const body of [
      { act: 'file' },
      { act: 'file', issue: REPORT_ID, createIssue: {} },
      { act: 'triage' },
    ]) {
      const res = await post(`/api/agent-reports/${REPORT_ID}/triage`, body);
      expect(res.status).toBe(400);
    }
    expect(triageReports).not.toHaveBeenCalled();
  });

  it('answers NOT_FOUND for an issue the caller cannot see, and writes nothing', async () => {
    readReport.mockResolvedValueOnce({ id: REPORT_ID, projectId: PROJECT_ID });
    visibleIssue.mockResolvedValueOnce(null);
    const res = await post(`/api/agent-reports/${REPORT_ID}/triage`, {
      act: 'file',
      issue: '55555555-5555-4555-8555-555555555555',
    });
    expect(res.status).toBe(404);
    expect(triageReports).not.toHaveBeenCalled();
  });

  it('the old reviewed door is gone: one write path, so a caller of it is told not found', async () => {
    const res = await post(`/api/agent-reports/${REPORT_ID}/reviewed`, { reviewed: true });
    expect(res.status).toBe(404);
  });

  it('answers on the old mount with the same body plus a deprecation field and headers', async () => {
    readReport.mockResolvedValueOnce({ id: REPORT_ID, projectId: PROJECT_ID });
    triageReports.mockResolvedValueOnce({ ok: true, effect: EFFECT, createdIssueId: null });
    const res = await post(`/api/feedback-reports/${REPORT_ID}/triage`, { act: 'reopen' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    expect(res.headers.get('Link')).toBe('</api/agent-reports>; rel="successor-version"');
    expect(await res.json()).toEqual({
      effect: EFFECT,
      deprecation: FEEDBACK_REPORTS_ALIAS_DEPRECATION,
    });
  });
});

describe('POST /api/agent-reports/triage, by signal', () => {
  it('scopes to the project and the signal and moves in bulk', async () => {
    triageReports.mockResolvedValueOnce({ ok: true, effect: EFFECT, createdIssueId: null });
    const res = await post('/api/agent-reports/triage', {
      signalKey: 'self_report:skill:x:friction',
      projectId: PROJECT_ID,
      triage: { act: 'dismiss', reason: 'fixed' },
    });
    expect(res.status).toBe(200);
    expect(triageReports).toHaveBeenCalledWith(expect.objectContaining({ bulk: true }));
  });

  it('refuses createIssue across every project, since an issue is filed in one', async () => {
    const res = await post('/api/agent-reports/triage', {
      signalKey: 'k',
      scope: 'all',
      triage: { act: 'file', createIssue: {} },
    });
    expect(res.status).toBe(400);
    expect(triageReports).not.toHaveBeenCalled();
  });
});

describe('GET /api/agent-reports', () => {
  it('keeps a list an array on the old mount and says it is deprecated in the headers', async () => {
    const res = await buildApp().request('/api/feedback-reports?scope=all');
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    expect(await res.json()).toEqual([]);
  });

  it('filters by triage and refuses the retired reviewed filter by name', async () => {
    expect((await buildApp().request('/api/agent-reports?scope=all&triage=new')).status).toBe(200);
    expect((await buildApp().request('/api/agent-reports?scope=all&reviewed=false')).status).toBe(
      400,
    );
  });
});
