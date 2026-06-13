import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

// Auth chain (requireAuth → emailVerified → loadProjectAccess) runs
// select().from()[.leftJoin()*].where().limit() — same FIFO mock shape as
// studio-routes.test.ts.
const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectLeftJoin = vi.fn(
  (): Record<string, unknown> => ({
    leftJoin: selectLeftJoin,
    where: selectWhere,
  }),
);
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

// Mock the smoke-verify service so the routes are tested at the route layer;
// the error class comes from the same mock so `instanceof` matches.
class NoRunnerOnlineError extends Error {
  readonly code = 'NO_RUNNER_ONLINE';
  constructor() {
    super('no runner is online for this project — canaries would queue forever');
    this.name = 'NoRunnerOnlineError';
  }
}
const buildSmokeVerifyReport = vi.fn();
const dispatchSmokeCanaries = vi.fn();
vi.mock('./smoke-verify.js', () => ({
  NoRunnerOnlineError,
  buildSmokeVerifyReport: (...args: unknown[]) => buildSmokeVerifyReport(...args),
  dispatchSmokeCanaries: (...args: unknown[]) => dispatchSmokeCanaries(...args),
}));

const { skillSmokeVerifyRoutes } = await import('./smoke-verify-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', skillSmokeVerifyRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const URL = `/api/projects/${PROJECT_ID}/skills/smoke-verify`;

const REPORT = {
  projectId: PROJECT_ID,
  generatedAt: '2026-06-12T10:00:00.000Z',
  tier1: [
    {
      stage: 'open',
      jobType: 'triage',
      skillId: 's-1',
      skillName: 'forge-triage',
      status: 'PASS',
      reason: null,
      detail: null,
      checkedAt: '2026-06-12T10:00:00.000Z',
      evidenceAt: '2026-06-11T00:00:00.000Z',
    },
  ],
  tier2: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectWhere.mockImplementation(() => ({ limit: selectLimit }));
  buildSmokeVerifyReport.mockResolvedValue(REPORT);
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

function accessAs(memberRole: string | null) {
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole, orgRole: null }]);
  if (!memberRole) selectLimit.mockResolvedValueOnce([]); // member fallthrough
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/projects/:projectId/skills/smoke-verify', () => {
  it('403 when caller is not a project member', async () => {
    authVerified();
    accessAs(null);
    const res = await buildApp().request(URL, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
    expect(buildSmokeVerifyReport).not.toHaveBeenCalled();
  });

  it('returns the aggregated report for a member', async () => {
    authVerified();
    accessAs('member');
    const res = await buildApp().request(URL, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
    expect(buildSmokeVerifyReport).toHaveBeenCalledWith(PROJECT_ID);
  });
});

describe('POST /api/projects/:projectId/skills/smoke-verify', () => {
  const post = async (body: unknown, role: string | null = 'member') => {
    authVerified();
    accessAs(role);
    return buildApp().request(URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  };

  it('tier 1 (default) re-runs the static checks without dispatching canaries', async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ report: REPORT, canary: null });
    expect(dispatchSmokeCanaries).not.toHaveBeenCalled();
  });

  it('tier 2 requires project admin', async () => {
    const res = await post({ tier: 2 }, 'member');
    expect(res.status).toBe(403);
    expect(dispatchSmokeCanaries).not.toHaveBeenCalled();
  });

  it('tier 2 dispatches canaries and returns the dispatch summary + fresh report', async () => {
    dispatchSmokeCanaries.mockResolvedValueOnce({
      dispatched: [{ stage: 'open', jobId: 'j-1', skillName: 'forge-triage' }],
      skipped: [{ stage: 'approved', reason: 'not_registered' }],
    });
    const res = await post({ tier: 2, stages: ['open', 'approved'] }, 'admin');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: unknown; canary: { dispatched: unknown } };
    expect(body.canary.dispatched).toEqual([
      { stage: 'open', jobId: 'j-1', skillName: 'forge-triage' },
    ]);
    expect(body.report).toEqual(REPORT);
    expect(dispatchSmokeCanaries).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      userId: USER_ID,
      stages: ['open', 'approved'],
    });
  });

  it('tier 2 maps NoRunnerOnlineError to 409 NO_RUNNER_ONLINE', async () => {
    dispatchSmokeCanaries.mockRejectedValueOnce(new NoRunnerOnlineError());
    const res = await post({ tier: 2 }, 'admin');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('NO_RUNNER_ONLINE');
  });

  it('400 on an unknown stage value', async () => {
    const res = await post({ tier: 2, stages: ['not-a-stage'] }, 'admin');
    expect(res.status).toBe(400);
  });
});
