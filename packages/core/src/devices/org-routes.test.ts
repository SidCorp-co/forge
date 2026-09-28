/**
 * The one claim about this route a mock is the right instrument for: a
 * malformed `orgId` is refused BEFORE any database read (ISS-1162). Which rows
 * the route returns is decided by a join and a visibility predicate, and is
 * proved against real Postgres in
 * `tests/integration/org-devices-scope-e2e.test.ts` — under a mocked row set
 * those assertions could not go red on a wrong `WHERE`.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthVars } from '../middleware/auth.js';
import type { RequestIdVars } from '../middleware/request-id.js';

vi.mock('../config/env.js', () => ({
  env: {
    DEVICE_TOKEN_PEPPER: 'y'.repeat(32),
    NODE_ENV: 'test',
    RATE_LIMIT_DEVICES_PAIR_MAX: 100,
    RATE_LIMIT_DEVICES_PAIR_WINDOW_MS: 60_000,
  },
}));

const chain: Record<string, unknown> = {};
const selectOrderBy = vi.fn(async () => [] as Array<Record<string, unknown>>);
chain.innerJoin = vi.fn(() => chain);
chain.where = vi.fn(() => chain);
chain.groupBy = vi.fn(() => chain);
chain.orderBy = selectOrderBy;
const selectFrom = vi.fn(() => chain);
const dbSelect = vi.fn(() => ({ from: selectFrom }));
vi.mock('../db/client.js', () => ({ db: { select: dbSelect } }));

const assertOrgAccess = vi.fn(async () => ({
  orgId: 'org-1',
  role: 'member' as const,
  isPersonal: false,
}));
const loadVisibleProjectIds = vi.fn(async () => ['proj-1']);
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  assertOrgAccess: (...a: unknown[]) => assertOrgAccess(...(a as [])),
  loadVisibleProjectIds: (...a: unknown[]) => loadVisibleProjectIds(...(a as [])),
}));

const { deviceOrgRoutes } = await import('./org-routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const ORG = '11111111-1111-4111-8111-111111111111';

/**
 * `deviceOrgRoutes` carries no auth of its own — it is mounted into `orgRoutes`,
 * which gates every path under `/api/orgs`. The stand-in here sets the one
 * variable that gate would have set, so the test exercises the handler and not
 * the middleware it borrows.
 */
function buildApp() {
  const gate = new Hono<{ Variables: AuthVars }>();
  gate.use('*', async (c, next) => {
    c.set('userId', 'u-1');
    await next();
  });
  gate.route('/', deviceOrgRoutes);

  const app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/orgs', gate);
  app.onError(errorHandler);
  return app;
}

const get = (path: string) =>
  new Request(`http://localhost${path}`, { headers: { authorization: 'Bearer user-jwt' } });

beforeEach(() => {
  vi.clearAllMocks();
  selectOrderBy.mockResolvedValue([]);
  loadVisibleProjectIds.mockResolvedValue(['proj-1']);
});

describe('GET /api/orgs/:orgId/devices', () => {
  it('refuses a malformed orgId with 400 before it reads the database', async () => {
    const res = await buildApp().fetch(get('/api/orgs/not-a-uuid/devices'));

    expect(res.status).toBe(400);
    expect(assertOrgAccess).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('checks org access before it reads the database', async () => {
    assertOrgAccess.mockRejectedValueOnce(
      new HTTPException(403, {
        message: 'requires org member access',
        cause: { code: 'FORBIDDEN' },
      }),
    );

    const res = await buildApp().fetch(get(`/api/orgs/${ORG}/devices`));

    expect(res.status).toBe(403);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('answers empty without a query when the caller can see no project at all', async () => {
    loadVisibleProjectIds.mockResolvedValueOnce([]);

    const res = await buildApp().fetch(get(`/api/orgs/${ORG}/devices`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(dbSelect).not.toHaveBeenCalled();
  });
});
