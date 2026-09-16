import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const _selectOffset = vi.fn(() => Promise.resolve([]));
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
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'admin',
      orgRole: 'owner',
    });
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
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'member',
      orgRole: null,
    });
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

// ISS-1015 — session_id is the key every cost rollup joins on, and since the
// rollups reach it by plain text equality a stored value in any other spelling
// is not an error anyone sees: it is a row every cost figure omits. These cases
// plant each spelling that would break that and assert what happens to it.
describe('usage_records.sessionId is a uuid or null', () => {
  // cm:guard the hex letters are the point: a digits-only uuid makes `toUpperCase()` a no-op, and
  // the lowercasing case below then passes against a build that does no lowercasing at all.
  const LOWER = '44a4bcde-f444-4f4e-8dcb-a44444444444';
  const UPPER = LOWER.toUpperCase();

  const post = async (path: string, body: unknown, role = 'member') => {
    authVerified();
    projectAccess.mockResolvedValue({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role,
      orgRole: null,
    });
    return buildApp().request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify(body),
    });
  };

  const record = (extra: Record<string, unknown>) => ({
    projectId: PROJECT_ID,
    source: 'cli',
    model: 'claude-haiku-4-5',
    inputTokens: 100,
    outputTokens: 10,
    recordedAt: new Date().toISOString(),
    ...extra,
  });

  const messages = (body: unknown): string[] => {
    const fields = (body as { details?: { fieldErrors?: Record<string, string[]> } }).details
      ?.fieldErrors;
    return Object.values(fields ?? {}).flat();
  };

  it('refuses a non-uuid sessionId, naming the field, the shape and the value', async () => {
    const res = await post('/api/usage-records', record({ sessionId: 'session-42' }));
    expect(res.status).toBe(400);
    const said = messages(await res.json()).join('\n');
    expect(said).toContain('sessionId');
    expect(said).toContain('agent_sessions.id');
    expect(said).toContain('canonical uuid');
    expect(said).toContain('"session-42"');
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('refuses an unhyphenated uuid, which ::uuid would have accepted', async () => {
    const res = await post('/api/usage-records', record({ sessionId: LOWER.replace(/-/g, '') }));
    expect(res.status).toBe(400);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('stores an uppercase-hex uuid lowercased, so the rollups still match it', async () => {
    insertReturning.mockResolvedValueOnce([{ id: RECORD_ID }]);
    const res = await post('/api/usage-records', record({ sessionId: UPPER }));
    expect(res.status).toBe(201);
    expect((insertValues.mock.calls[0]?.[0] as { sessionId: string }).sessionId).toBe(LOWER);
  });

  it('still accepts an omitted sessionId, and an explicit null', async () => {
    insertReturning.mockResolvedValueOnce([{ id: RECORD_ID }]);
    expect((await post('/api/usage-records', record({}))).status).toBe(201);
    expect((insertValues.mock.calls[0]?.[0] as { sessionId: null }).sessionId).toBeNull();

    vi.clearAllMocks();
    insertReturning.mockResolvedValueOnce([{ id: RECORD_ID }]);
    expect((await post('/api/usage-records', record({ sessionId: null }))).status).toBe(201);
    expect((insertValues.mock.calls[0]?.[0] as { sessionId: null }).sessionId).toBeNull();
  });

  // cm:guard the batch routes validate the whole array before inserting any of it, which is their
  // existing contract for every other field. What this change owes is therefore not a new recovery
  // mechanism but a refusal a client can act on in ONE round trip — so the answer has to name EVERY
  // offending record, not stop at the first, and the corrected batch has to go in whole.
  it('names every offending record of a batch, stores none of it, and takes the corrected batch', async () => {
    const bad = await post('/api/usage-records/bulk', {
      records: [
        record({ sessionId: 'nope-0' }),
        record({ sessionId: LOWER }),
        record({ sessionId: 'nope-2' }),
      ],
    });
    expect(bad.status).toBe(400);
    const said = messages(await bad.json());
    expect(said.filter((m) => m.includes('records.0.sessionId'))).toHaveLength(1);
    expect(said.filter((m) => m.includes('records.2.sessionId'))).toHaveLength(1);
    expect(said.some((m) => m.includes('records.1'))).toBe(false);
    expect(insertValues).not.toHaveBeenCalled();

    vi.clearAllMocks();
    insertReturning.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const fixed = await post('/api/usage-records/bulk', {
      records: [
        record({ sessionId: LOWER }),
        record({ sessionId: LOWER }),
        record({ sessionId: UPPER }),
      ],
    });
    expect(fixed.status).toBe(200);
    expect(await fixed.json()).toEqual({ count: 3 });
    const rows = insertValues.mock.calls[0]?.[0] as Array<{ sessionId: string }>;
    expect(rows.map((r) => r.sessionId)).toEqual([LOWER, LOWER, LOWER]);
  });

  it('holds the same line on ingest-cli, which is /bulk with a fixed source', async () => {
    const res = await post('/api/usage-records/ingest-cli', {
      records: [record({ sessionId: 'not-a-uuid' })],
    });
    expect(res.status).toBe(400);
    expect(insertValues).not.toHaveBeenCalled();
  });
});
