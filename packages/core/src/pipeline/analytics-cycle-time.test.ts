/**
 * ISS-1022 — `GET /api/pipeline/cycle-time` and its window.
 *
 * Split out of `analytics-routes.test.ts`, which is at its frozen size budget.
 * The mock preamble is duplicated rather than shared because `vi.mock` factories
 * are hoisted per file, and a shared module would have to be re-mocked in each
 * one anyway; what is NOT duplicated is the route under test.
 */

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const dbExecute = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: selectWhere })) })),
    selectDistinct: vi.fn(),
    execute: (q: unknown) => dbExecute(q),
  },
}));

const visibleIds = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadVisibleProjectIds: (...args: unknown[]) => visibleIds(...args),
}));

const routes = await import('./analytics-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/pipeline', routes.pipelineAnalyticsRoutes);
  app.onError(errorHandler);
  return app;
}

function req(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  const { token: _t, ...rest } = init;
  return new Request(`http://localhost${path}`, { ...rest, headers });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/pipeline/cycle-time', () => {
  it('401 without token', async () => {
    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/cycle-time'));
    expect(res.status).toBe(401);
  });

  it('400 on bad projectId uuid', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/cycle-time?projectId=not-uuid', { token }));
    expect(res.status).toBe(400);
  });

  it('returns [] when user has no visible projects', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    visibleIds.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/cycle-time', { token }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns avgHours per status', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    visibleIds.mockResolvedValueOnce(['p-1']);
    dbExecute.mockResolvedValueOnce([
      { status: 'open', avg_hours: 4.5, n: 12 },
      { status: 'in_progress', avg_hours: 23.1, n: 8 },
    ]);

    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/cycle-time', { token }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ status: string; avgHours: number; n: number }>;
    expect(body).toHaveLength(2);
    expect(body[0]?.status).toBe('open');
    expect(body[0]?.avgHours).toBe(4.5);
    expect(body[1]?.n).toBe(8);
  });

  // cm:guard ISS-1022 — the window is in the SQL and not only in the schema, so these read the statement the route sent rather than its status code: a `days` that parses, defaults and refuses correctly while never reaching the query is the shape this endpoint had before, and it is what made one request scan every status transition of every visible project.
  // cm:guard the walk RECURSES into a nested `SQL` chunk, and must: a chunk is a `StringChunk` of literal text, a nested statement with chunks of its own, or a bare bound value, and a walk that stops at the top level reports the window predicate missing the moment the CTE is composed from a helper rather than written inline. `JSON.stringify` of the statement is not an option — it throws on the circular `PgTable` graph.
  const cycleTimeScan = async (query: string) => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    visibleIds.mockResolvedValueOnce(['p-1']);
    dbExecute.mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await app.fetch(req(`/api/pipeline/cycle-time${query}`, { token }));
    expect(res.status).toBe(200);
    const sent = dbExecute.mock.calls.at(-1)?.[0] as { queryChunks: unknown[] };
    const literals: string[] = [];
    const params: unknown[] = [];
    const walk = (chunks: unknown[]) => {
      for (const chunk of chunks) {
        if (typeof chunk !== 'object' || chunk === null) {
          params.push(chunk);
          continue;
        }
        const c = chunk as { value?: unknown; queryChunks?: unknown[] };
        if (Array.isArray(c.queryChunks)) walk(c.queryChunks);
        else if (Array.isArray(c.value)) literals.push(c.value.join(''));
        else if ('value' in c) params.push(c.value);
      }
    };
    walk(sent.queryChunks);
    return { sql: literals.join(' '), params };
  };

  it('bounds the transition scan to 30 days when no days is asked for', async () => {
    const scan = await cycleTimeScan('');
    expect(scan.sql).toContain("interval '1 day'");
    expect(scan.params).toContain(30);
  });

  it('bounds the transition scan to the days asked for', async () => {
    const scan = await cycleTimeScan('?days=90');
    expect(scan.sql).toContain("interval '1 day'");
    expect(scan.params).toContain(90);
    expect(scan.params).not.toContain(30);
  });

  it('400 on days below the floor', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/cycle-time?days=0', { token }));
    expect(res.status).toBe(400);
  });

  it('400 on days above the ceiling', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/cycle-time?days=91', { token }));
    expect(res.status).toBe(400);
  });
});
