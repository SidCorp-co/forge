// The case ISS-991 exists for: `?key=ISS-376` was answered 200 with the project's
// whole issue list. Every assertion below goes red if `.strict()` leaves
// `issueFiltersSchema`, because a stripped key is a 200 and not a 400.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const countRows = vi.fn(async () => [{ n: 0 }]);
const pageOffset = vi.fn(async () => []);
const pageLimit = vi.fn(() => ({ offset: pageOffset }));
const selectOrderBy = vi.fn(() => ({ limit: pageLimit }));
// cm:why `where()` is both awaited (the count query) and chained off (the page query) in one handler, so the mock has to be a thenable that also carries `orderBy` and `limit`
const selectWhere = vi.fn(() => ({
  limit: selectLimit,
  orderBy: selectOrderBy,
  then: (resolve: (v: unknown) => unknown) => countRows().then(resolve),
}));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(),
    execute: vi.fn(async () => []),
    transaction: vi.fn(),
  },
}));

vi.mock('../ws/server.js', () => ({
  roomManager: { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

vi.mock('../jobs/enqueue.js', () => ({ enqueueJob: vi.fn() }));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const { issueProjectRoutes, issueFiltersSchema } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', issueProjectRoutes);
  app.onError(errorHandler);
  return app;
}

async function list(query: string) {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
  projectAccess.mockResolvedValue({ projectId: PROJECT_ID, orgId: 'org-1', role: 'admin' });
  const res = await buildApp().request(`/api/projects/${PROJECT_ID}/issues?${query}`, {
    headers: { authorization: `Bearer ${await signUserToken(USER_ID)}` },
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectLimit.mockImplementation(() => Promise.resolve([] as unknown[]));
  countRows.mockClear();
  pageOffset.mockClear();
  projectAccess.mockReset();
});

describe('GET /api/projects/:id/issues — unregistered query parameters', () => {
  it('refuses an unregistered query parameter by name', async () => {
    const { res, body } = await list('nonsense=1');

    expect(res.status).toBe(400);
    expect(body.message).toContain('nonsense');
  });

  it('answers a filtered ask with a refusal rather than an unfiltered page', async () => {
    const { res, body } = await list('bogusKey=ISS-376');

    expect(res.status).toBe(400);
    expect(body).not.toHaveProperty('items');
  });

  it('lists every parameter the route does filter on', async () => {
    const { body } = await list('nonsense=1');

    const accepted = (body.details as { accepted: string[] }).accepted;
    expect(accepted).toEqual(Object.keys(issueFiltersSchema.shape).sort());
    for (const name of ['status', 'priority', 'assigneeId', 'category', 'key', 'limit', 'offset']) {
      expect(body.message).toContain(name);
    }
  });

  // cm:why this is the one assertion a hand-kept accepted-list cannot pass: every other case above is satisfied by a literal that happens to match the schema today
  it('would list a parameter added to the schema with no edit to the refusal', async () => {
    const grown = issueFiltersSchema.extend({ freshlyAdded: (await import('zod')).z.string() });
    const { queryBadRequest } = await import('../lib/query-strict.js');
    const parsed = grown.safeParse({ nonsense: '1' });

    const cause = queryBadRequest(grown, parsed.error as never).cause as {
      details: { accepted: string[] };
    };
    expect(cause.details.accepted).toContain('freshlyAdded');
  });

  it('carries UNKNOWN_QUERY_PARAMETER, not a bare BAD_REQUEST', async () => {
    const { body } = await list('nonsense=1');

    expect(body.code).toBe('UNKNOWN_QUERY_PARAMETER');
  });

  it('names both an unknown parameter and a known one whose value will not parse', async () => {
    const { res, body } = await list('nonsense=1&limit=abc');

    expect(res.status).toBe(400);
    const details = body.details as {
      unknownParameters: string[];
      fieldErrors: Record<string, unknown>;
    };
    expect(details.unknownParameters).toEqual(['nonsense']);
    expect(details.fieldErrors.limit).toBeDefined();
  });

  it('refuses a malformed `key` by field rather than as an unknown parameter', async () => {
    const { res, body } = await list('key=not-a-key');

    expect(res.status).toBe(400);
    expect(body.code).toBe('BAD_REQUEST');
    expect(
      (body.details as { fieldErrors: Record<string, unknown> }).fieldErrors.key,
    ).toBeDefined();
  });

  it('refuses `key=0`, which no issue can hold', async () => {
    const { res } = await list('key=0');

    expect(res.status).toBe(400);
  });

  // cm:why an out-of-range int reaches Postgres as a 500, so the digit bound in the schema is what keeps a caller's typo a 400
  it('refuses a `key` too long to be an int4', async () => {
    const { res } = await list('key=99999999999999');

    expect(res.status).toBe(400);
  });

  it('accepts a registered parameter', async () => {
    const { res, body } = await list('status=open');

    expect(res.status).toBe(200);
    expect(body.items).toEqual([]);
  });
});
