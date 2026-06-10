import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectOffset = vi.fn(() => Promise.resolve([]));
const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
const selectGroupBy = vi.fn();
const selectWhere = vi.fn(() => ({
  limit: selectLimit,
  orderBy: selectOrderBy,
  groupBy: selectGroupBy,
}));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const insertReturning = vi.fn();
const insertValues = vi.fn((..._args: unknown[]) => ({ returning: insertReturning }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
  },
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const { usageRecordRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/usage-records', usageRecordRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const RECORD_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOrderBy.mockReset();
  selectOrderBy.mockImplementation(() => ({ limit: selectLimit }));
  selectGroupBy.mockReset();
  insertReturning.mockReset();
  projectAccess.mockReset();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('POST /api/usage-records', () => {
  it('400 missing fields', async () => {
    authVerified();
    const res = await buildApp().request('/api/usage-records', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ source: 'cli' }),
    });
    expect(res.status).toBe(400);
  });

  it('201 inserts record with computed cost', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'admin', orgRole: 'owner' });
    insertReturning.mockResolvedValueOnce([
      { id: RECORD_ID, model: 'claude-sonnet-4', estimatedCost: 0.1 },
    ]);

    const res = await buildApp().request('/api/usage-records', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        source: 'desktop',
        model: 'claude-sonnet-4',
        inputTokens: 10_000,
        outputTokens: 1_000,
        recordedAt: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(RECORD_ID);
    const insertCall = insertValues.mock.calls[0]?.[0] as { estimatedCost: number };
    expect(insertCall.estimatedCost).toBeGreaterThan(0);
  });
});

describe('POST /api/usage-records/bulk', () => {
  it('inserts batch + returns count', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null });
    insertReturning.mockResolvedValueOnce([{ id: RECORD_ID }, { id: 'r2' }]);

    const res = await buildApp().request('/api/usage-records/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        records: [
          {
            projectId: PROJECT_ID,
            source: 'cli',
            model: 'claude-haiku-4-5',
            inputTokens: 100,
            outputTokens: 10,
            recordedAt: new Date().toISOString(),
          },
          {
            projectId: PROJECT_ID,
            source: 'cli',
            model: 'claude-haiku-4-5',
            inputTokens: 200,
            outputTokens: 20,
            recordedAt: new Date().toISOString(),
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(2);
  });
});

describe('pricing.estimateCost', () => {
  it('returns 0 for unknown model', async () => {
    const { estimateCost } = await import('./pricing.js');
    expect(estimateCost('mystery-model', { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
  });

  it('non-zero for known model', async () => {
    const { estimateCost } = await import('./pricing.js');
    expect(
      estimateCost('claude-sonnet-4', { inputTokens: 1_000_000, outputTokens: 100_000 }),
    ).toBeCloseTo(3 + 1.5, 3);
  });
});
