import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

// Each `await db.select()...chain()` resolves with the next item from the
// queue. This mirrors drizzle's thenable QueryBuilder while keeping the test
// independent of the exact chain shape (selectDistinct / leftJoin / innerJoin
// / orderBy / groupBy / limit all coexist in this handler).
const queryQueue: unknown[] = [];

// Captures every `sql` template handed to `db.execute(...)` so a test can assert
// the literal SQL text (the mock resolves data but can't exercise Postgres type
// binding — see the `::uuid[]` regression test below).
const executedSql: unknown[] = [];

function makeChain() {
  const chain: Record<string, unknown> & PromiseLike<unknown> = {} as never;
  const methods = [
    'from',
    'where',
    'leftJoin',
    'innerJoin',
    'orderBy',
    'groupBy',
    'limit',
    'offset',
    'set',
    'values',
    'returning',
  ];
  for (const m of methods) (chain as Record<string, unknown>)[m] = () => chain;
  (chain as { then: PromiseLike<unknown>['then'] }).then = (resolve, reject) => {
    const result = queryQueue.shift() ?? [];
    return Promise.resolve(result).then(resolve, reject);
  };
  return chain;
}

vi.mock('../db/client.js', () => ({
  db: {
    select: () => makeChain(),
    selectDistinct: () => makeChain(),
    insert: () => makeChain(),
    update: () => makeChain(),
    delete: () => makeChain(),
    // `db.execute(sql`...`)` (the trailing-24h spend view query) is awaited
    // directly; it shifts the same queue as the chained selects. The template is
    // captured so a test can assert the literal SQL (e.g. the `::uuid[]` cast).
    execute: (query: unknown) => {
      executedSql.push(query);
      return makeChain();
    },
  },
}));

const { projectHealthRoutes } = await import('./health-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{
    Variables: import('../middleware/request-id.js').RequestIdVars;
  }>();
  app.use('*', requestId());
  app.route('/api/projects', projectHealthRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_A_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_B_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  queryQueue.length = 0;
  executedSql.length = 0;
});

async function token() {
  return signUserToken(USER_ID);
}

function authVerified() {
  // assertEmailVerified middleware: select users.emailVerifiedAt
  queryQueue.push([{ emailVerifiedAt: new Date() }]);
}

describe('GET /api/projects/health', () => {
  it('401 without token', async () => {
    const res = await buildApp().request('/api/projects/health');
    expect(res.status).toBe(401);
  });

  it('returns [] when caller has no visible projects', async () => {
    authVerified();
    queryQueue.push([{ id: USER_ID, isCeo: false }]); // me
    queryQueue.push([]); // visibleProjects (empty → handler short-circuits)

    const res = await buildApp().request('/api/projects/health', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('200 with health rows including throughput from issue.statusChanged activity', async () => {
    authVerified();
    queryQueue.push([{ id: USER_ID, isCeo: false }]); // me
    queryQueue.push([
      { id: PROJECT_A_ID, slug: 'alpha', name: 'Alpha', agentConfig: null },
      { id: PROJECT_B_ID, slug: 'beta', name: 'Beta', agentConfig: { foo: 1 } },
    ]); // visibleProjects
    queryQueue.push([
      { projectId: PROJECT_A_ID, status: 'open', n: 3 },
      { projectId: PROJECT_A_ID, status: 'in_progress', n: 1 },
      { projectId: PROJECT_B_ID, status: 'needs_info', n: 2 },
    ]); // statusRows
    queryQueue.push([]); // blockerRowsAll
    queryQueue.push([
      { projectId: PROJECT_A_ID, n: 2 },
    ]); // throughputRows — counts issue.statusChanged → closed/released in last 7 days

    const res = await buildApp().request('/api/projects/health', {
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      projectSlug: string;
      throughput: number;
      totalActive: number;
      pendingEscalations: number;
    }>;

    expect(body).toHaveLength(2);
    const alpha = body.find((p) => p.projectSlug === 'alpha');
    const beta = body.find((p) => p.projectSlug === 'beta');
    expect(alpha?.throughput).toBe(2);
    expect(alpha?.totalActive).toBe(4); // open(3) + in_progress(1)
    expect(beta?.throughput).toBe(0); // no qualifying activity
    expect(beta?.pendingEscalations).toBe(2); // needs_info bucket
  });

  it('200 with throughput=0 when no activity rows match (regression: empty result must not 500)', async () => {
    authVerified();
    queryQueue.push([{ id: USER_ID, isCeo: false }]);
    queryQueue.push([
      { id: PROJECT_A_ID, slug: 'alpha', name: 'Alpha', agentConfig: null },
    ]);
    queryQueue.push([{ projectId: PROJECT_A_ID, status: 'open', n: 1 }]);
    queryQueue.push([]); // blockerRowsAll
    queryQueue.push([]); // throughputRows — empty (was the original 500 trigger)

    const res = await buildApp().request('/api/projects/health', {
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ throughput: number }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.throughput).toBe(0);
  });

  it('200 with additive rollups (liveRuns / runners / spend24h / members / lastActivityAt)', async () => {
    authVerified();
    queryQueue.push([{ id: USER_ID, isCeo: false }]); // me
    queryQueue.push([
      {
        id: PROJECT_A_ID,
        slug: 'alpha',
        name: 'Alpha',
        agentConfig: null,
        description: 'Alpha project',
        repoPath: 'org/alpha',
      },
      {
        id: PROJECT_B_ID,
        slug: 'beta',
        name: 'Beta',
        agentConfig: null,
        description: null,
        repoPath: null,
      },
    ]); // visibleProjects
    queryQueue.push([{ projectId: PROJECT_A_ID, status: 'open', n: 2 }]); // statusRows
    queryQueue.push([]); // blockerRowsAll
    queryQueue.push([]); // throughputRows
    queryQueue.push([{ projectId: PROJECT_A_ID, n: 3 }]); // liveRunRows
    queryQueue.push([{ projectId: PROJECT_A_ID, n: 2 }]); // runnerRows
    queryQueue.push([{ project_id: PROJECT_A_ID, spend: 13.38 }]); // spendRows (db.execute)
    queryQueue.push([
      { projectId: PROJECT_A_ID, email: 'ada@x.io', joinedAt: new Date() },
      { projectId: PROJECT_A_ID, email: 'bob@x.io', joinedAt: new Date() },
    ]); // memberRows
    queryQueue.push([{ projectId: PROJECT_A_ID, lastAt: '2026-05-30T10:00:00.000Z' }]); // issueActivityRows
    queryQueue.push([{ projectId: PROJECT_A_ID, lastAt: '2026-05-31T12:00:00.000Z' }]); // runActivityRows

    const res = await buildApp().request('/api/projects/health', {
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      projectSlug: string;
      description: string | null;
      repoPath: string | null;
      liveRuns: number;
      runnerCount: number;
      spend24hUsd: number;
      memberCount: number;
      members: string[];
      lastActivityAt: string | null;
    }>;

    const alpha = body.find((p) => p.projectSlug === 'alpha');
    const beta = body.find((p) => p.projectSlug === 'beta');
    expect(alpha?.id).toBe(PROJECT_A_ID);
    expect(alpha?.description).toBe('Alpha project');
    expect(alpha?.repoPath).toBe('org/alpha');
    expect(alpha?.liveRuns).toBe(3);
    expect(alpha?.runnerCount).toBe(2);
    expect(alpha?.spend24hUsd).toBeCloseTo(13.38);
    expect(alpha?.memberCount).toBe(2);
    expect(alpha?.members).toEqual(['AD', 'BO']); // email-derived initials
    expect(alpha?.lastActivityAt).toBe('2026-05-31T12:00:00.000Z'); // max(issue, run)
    // Project with no rollup rows falls back to safe defaults.
    expect(beta?.liveRuns).toBe(0);
    expect(beta?.runnerCount).toBe(0);
    expect(beta?.spend24hUsd).toBe(0);
    expect(beta?.memberCount).toBe(0);
    expect(beta?.members).toEqual([]);
    expect(beta?.lastActivityAt).toBeNull();
    expect(beta?.description).toBeNull();
  });

  it('spend query uses IN (...) not ANY(::uuid[]) (regression: array binding 500s on live twice)', async () => {
    // The trailing-24h spend query must filter project ids with `IN (...)` over a
    // sql.join parameter list — NOT `= ANY(${projectIds})` / `ANY(...::uuid[])`.
    // Embedding a JS array directly in the drizzle template expands it as a
    // record tuple ($1,$2,...), so ANY(tuple) / tuple::uuid[] is a malformed
    // array literal and 500s the whole endpoint (regressing the shared v1
    // dashboard). Two prior live FAILs (ANY, then ANY+::uuid[]) confirm this.
    // The db mock can't bind real Postgres, so assert the literal SQL shape:
    // it must say `IN (` and must NOT carry `ANY(` or `::uuid[]`.
    authVerified();
    queryQueue.push([{ id: USER_ID, isCeo: false }]); // me
    queryQueue.push([
      { id: PROJECT_A_ID, slug: 'alpha', name: 'Alpha', agentConfig: null },
    ]); // visibleProjects
    queryQueue.push([]); // statusRows
    queryQueue.push([]); // blockerRowsAll
    queryQueue.push([]); // throughputRows
    queryQueue.push([]); // liveRunRows
    queryQueue.push([]); // runnerRows
    queryQueue.push([]); // spendRows (db.execute)

    const res = await buildApp().request('/api/projects/health', {
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    // The captured sql template serializes its literal chunks.
    const serialized = JSON.stringify(executedSql);
    expect(serialized).toContain('pipeline_run_step_durations');
    expect(serialized).toContain('IN (');
    expect(serialized).not.toContain('ANY(');
    expect(serialized).not.toContain('::uuid[]');
  });

  it('CEO branch: skips project-membership filter', async () => {
    authVerified();
    queryQueue.push([{ id: USER_ID, isCeo: true }]); // CEO
    queryQueue.push([
      { id: PROJECT_A_ID, slug: 'alpha', name: 'Alpha', agentConfig: null },
    ]); // visibleProjects (unrestricted select)
    queryQueue.push([]); // statusRows
    queryQueue.push([]); // blockerRowsAll
    queryQueue.push([{ projectId: PROJECT_A_ID, n: 5 }]); // throughputRows

    const res = await buildApp().request('/api/projects/health', {
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ throughput: number }>;
    expect(body[0]?.throughput).toBe(5);
  });
});
