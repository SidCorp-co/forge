/** ISS-1273 — `GET /api/projects/health` names the axis the loop monitor sweeps and counts what
 *  sits outside it. A sibling suite because `health-routes.test.ts`'s one describe is at its
 *  function-length budget. */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({ env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' } }));

const queryQueue: unknown[] = [];

function makeChain() {
  const chain: Record<string, unknown> & PromiseLike<unknown> = {} as never;
  for (const m of ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'groupBy', 'limit']) {
    (chain as Record<string, unknown>)[m] = () => chain;
  }
  (chain as { then: PromiseLike<unknown>['then'] }).then = (resolve, reject) =>
    Promise.resolve(queryQueue.shift() ?? []).then(resolve, reject);
  return chain;
}

vi.mock('../db/client.js', () => ({
  db: { select: () => makeChain(), selectDistinct: () => makeChain(), execute: () => makeChain() },
}));

const { projectHealthRoutes } = await import('./health-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
/** A claim renewed far enough ahead that `classifyLease` reads it live wherever this runs. */
const FUTURE = new Date(Date.now() + 30 * 60_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  queryQueue.length = 0;
});

async function health() {
  queryQueue.unshift(
    [{ emailVerifiedAt: new Date() }],
    [{ id: PROJECT_ID }],
    [{ id: PROJECT_ID, slug: 'alpha', name: 'Alpha', agentConfig: null }],
    [{ projectId: PROJECT_ID, status: 'open', n: 1 }],
  );
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', projectHealthRoutes);
  app.onError(errorHandler);
  return app.request('/api/projects/health', {
    headers: { authorization: `Bearer ${await signUserToken(USER_ID)}` },
  });
}

type Row = { loopMonitor: { axis: string; claimHeldIssues: number; sweptBy: string } };

describe('GET /api/projects/health — the loop monitor axis (ISS-1273)', () => {
  // One of the two readers this pair got; `loop-monitor-axis.ts` logs the same on every tick.
  it('names the axis and counts the claim-held issues outside it', async () => {
    for (let i = 0; i < 9; i++) queryQueue.push([]);
    queryQueue.push([
      { project_id: PROJECT_ID, lease: { holder: 'iss-1-aaaa', renewedAt: FUTURE, minutes: 60 } },
      { project_id: PROJECT_ID, lease: { holder: 'iss-2-bbbb', renewedAt: FUTURE, minutes: 60 } },
    ]);

    const res = await health();
    expect(res.status).toBe(200);
    expect(((await res.json()) as Row[])[0]?.loopMonitor).toEqual({
      axis: 'job',
      claimHeldIssues: 2,
      sweptBy: 'pipeline/idle-issues.ts',
    });
  });

  // Served only above zero, its absence would mean "none held" and "nobody counted" alike.
  it('serves the count as zero rather than leaving the field out', async () => {
    const res = await health();
    expect(res.status).toBe(200);
    expect(((await res.json()) as Row[])[0]?.loopMonitor.claimHeldIssues).toBe(0);
  });
});
