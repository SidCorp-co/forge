import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

// FIFO queue mirroring drizzle's thenable QueryBuilder — each awaited chain
// resolves with the next queued item. Same harness as health-routes.test.ts.
const queryQueue: unknown[] = [];
const executedSql: unknown[] = [];

function makeChain() {
  const chain: Record<string, unknown> & PromiseLike<unknown> = {} as never;
  const methods = ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'groupBy', 'limit'];
  for (const m of methods) (chain as Record<string, unknown>)[m] = () => chain;
  // biome-ignore lint/suspicious/noThenProperty: test double mirrors drizzle's thenable QueryBuilder
  (chain as { then: PromiseLike<unknown>['then'] }).then = (resolve, reject) => {
    const result = queryQueue.shift() ?? [];
    return Promise.resolve(result).then(resolve, reject);
  };
  return chain;
}

vi.mock('../db/client.js', () => ({
  db: {
    select: () => makeChain(),
    execute: (query: unknown) => {
      executedSql.push(query);
      return makeChain();
    },
  },
}));

const { projectMetricsRoutes } = await import('./routes.js');
const { bucketTimestamps } = await import('./queries.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', projectMetricsRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const RUNNER_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  queryQueue.length = 0;
  executedSql.length = 0;
});

function token() {
  return signUserToken(USER_ID);
}

function authVerified() {
  queryQueue.push([{ emailVerifiedAt: new Date() }]);
}

/** Push the two loadProjectAccess selects: project row, then membership row. */
function accessAsOwner() {
  queryQueue.push([{ id: PROJECT_ID, ownerId: USER_ID }]); // project
  queryQueue.push([]); // membership (owner not in members → allowed via ownerId)
}

function url(metric: string, extra = '') {
  return `/api/projects/${PROJECT_ID}/metrics/timeseries?metric=${metric}${extra}`;
}

describe('GET /api/projects/:id/metrics/timeseries — auth & validation', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(url('cost'));
    expect(res.status).toBe(401);
  });

  it('400 on non-uuid project id', async () => {
    authVerified();
    const res = await buildApp().request(
      '/api/projects/not-a-uuid/metrics/timeseries?metric=cost',
      { headers: { authorization: `Bearer ${await token()}` } },
    );
    expect(res.status).toBe(400);
  });

  it('400 on unknown metric', async () => {
    authVerified();
    const res = await buildApp().request(url('bogus'), {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });

  it('400 on bad bucket', async () => {
    authVerified();
    const res = await buildApp().request(url('cost', '&bucket=week'), {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });

  it('400 when days exceeds the 90-day cap', async () => {
    authVerified();
    const res = await buildApp().request(url('cost', '&days=120'), {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });

  it('403 when caller is neither owner nor member', async () => {
    authVerified();
    queryQueue.push([{ id: PROJECT_ID, ownerId: OTHER_USER }]); // project
    queryQueue.push([]); // membership empty
    const res = await buildApp().request(url('cost'), {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('GET …/metrics/timeseries — series shape', () => {
  it('cost: dense daily series of `days` length, scoped + windowed SQL', async () => {
    authVerified();
    accessAsOwner();
    queryQueue.push([]); // cost rows (empty → all-zero dense series)
    const res = await buildApp().request(url('cost', '&days=14'), {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metric: string;
      bucket: string;
      days: number;
      groupBy: string | null;
      series: Array<{ ts: string; costUsd: number }>;
    };
    expect(body.metric).toBe('cost');
    expect(body.bucket).toBe('day');
    expect(body.groupBy).toBeNull();
    expect(body.series).toHaveLength(14);
    expect(body.series.every((p) => typeof p.ts === 'string' && p.costUsd === 0)).toBe(true);
    const serialized = JSON.stringify(executedSql);
    expect(serialized).toContain('usage_records');
    expect(serialized).toContain('date_trunc');
    // single-project scoping + SQL-side window cutoff (no JS Date binding)
    expect(serialized).toContain('project_id =');
    expect(serialized).toContain("interval '1 day'");
  });

  it('cost: maps a row onto its bucket', async () => {
    authVerified();
    accessAsOwner();
    const buckets = bucketTimestamps(7, 'day', new Date());
    const today = buckets[buckets.length - 1];
    queryQueue.push([{ bucket: today, cost_usd: 4.25 }]);
    const res = await buildApp().request(url('cost', '&days=7'), {
      headers: { authorization: `Bearer ${await token()}` },
    });
    const body = (await res.json()) as { series: Array<{ ts: string; costUsd: number }> };
    expect(body.series).toHaveLength(7);
    expect(body.series.find((p) => p.ts === today)?.costUsd).toBeCloseTo(4.25);
  });

  it('cost groupBy=step: per-step dense series, hits the durations view', async () => {
    authVerified();
    accessAsOwner();
    const buckets = bucketTimestamps(3, 'day', new Date());
    queryQueue.push([
      { bucket: buckets[2], step: 'code', cost_usd: 2 },
      { bucket: buckets[2], step: 'review', cost_usd: 1 },
    ]);
    const res = await buildApp().request(url('cost', '&days=3&groupBy=step'), {
      headers: { authorization: `Bearer ${await token()}` },
    });
    const body = (await res.json()) as {
      groupBy: string | null;
      series: Array<{ ts: string; step: string; costUsd: number }>;
    };
    expect(body.groupBy).toBe('step');
    // two distinct steps × 3 buckets each
    expect(body.series).toHaveLength(6);
    expect(new Set(body.series.map((p) => p.step))).toEqual(new Set(['code', 'review']));
    expect(JSON.stringify(executedSql)).toContain('pipeline_run_step_durations');
  });

  it('throughput: cumulative is monotonic non-decreasing', async () => {
    authVerified();
    accessAsOwner();
    const buckets = bucketTimestamps(5, 'day', new Date());
    queryQueue.push([
      { bucket: buckets[1], resolved: 2 },
      { bucket: buckets[3], resolved: 3 },
    ]);
    const res = await buildApp().request(url('throughput', '&days=5'), {
      headers: { authorization: `Bearer ${await token()}` },
    });
    const body = (await res.json()) as {
      series: Array<{ ts: string; resolved: number; cumulative: number }>;
    };
    expect(body.series).toHaveLength(5);
    let prev = -1;
    for (const p of body.series) {
      expect(p.cumulative).toBeGreaterThanOrEqual(prev);
      prev = p.cumulative;
    }
    expect(body.series[body.series.length - 1]?.cumulative).toBe(5); // 2 + 3
    const serialized = JSON.stringify(executedSql);
    expect(serialized).toContain('issue.statusChanged');
    expect(serialized).toContain('activity_log');
  });

  it('cycle_time: derives work-start from in_progress/approved, not createdAt', async () => {
    authVerified();
    accessAsOwner();
    queryQueue.push([]); // empty → all-zero dense series
    const res = await buildApp().request(url('cycle_time', '&days=10'), {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { series: Array<{ avgDays: number; p50Days: number }> };
    expect(body.series).toHaveLength(10);
    const serialized = JSON.stringify(executedSql);
    expect(serialized).toContain('in_progress');
    expect(serialized).toContain('approved');
    expect(serialized).toContain('percentile_disc');
  });

  it('queue_wait: median/p95 from queued→dispatched', async () => {
    authVerified();
    accessAsOwner();
    queryQueue.push([]);
    const res = await buildApp().request(url('queue_wait', '&days=4'), {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { series: Array<{ medianMs: number; p95Ms: number }> };
    expect(body.series).toHaveLength(4);
    expect(JSON.stringify(executedSql)).toContain('dispatched_at');
  });

  it('runner_utilization: per-runner dense series with busyPct clamped to 1', async () => {
    authVerified();
    accessAsOwner();
    const buckets = bucketTimestamps(3, 'day', new Date());
    queryQueue.push([{ bucket: buckets[0], runner_id: RUNNER_ID, busy_pct: 1.7 }]);
    const res = await buildApp().request(url('runner_utilization', '&days=3'), {
      headers: { authorization: `Bearer ${await token()}` },
    });
    const body = (await res.json()) as {
      series: Array<{ ts: string; runnerId: string; busyPct: number }>;
    };
    expect(body.series).toHaveLength(3); // one runner × 3 buckets
    expect(body.series.every((p) => p.runnerId === RUNNER_ID)).toBe(true);
    expect(body.series.find((p) => p.ts === buckets[0])?.busyPct).toBe(1); // clamped
  });

  it('cache_hit_rate: null when no rows in a bucket', async () => {
    authVerified();
    accessAsOwner();
    queryQueue.push([]);
    const res = await buildApp().request(url('cache_hit_rate', '&days=2'), {
      headers: { authorization: `Bearer ${await token()}` },
    });
    const body = (await res.json()) as {
      series: Array<{ cacheHitRate: number | null; n: number }>;
    };
    expect(body.series).toHaveLength(2);
    expect(body.series.every((p) => p.cacheHitRate === null && p.n === 0)).toBe(true);
    // Sourced from usage_records (NOT the pipeline_run_step_durations view, whose
    // deployed 0057 shape lacks the cache-token columns — see ISS-380 fix).
    const serialized = JSON.stringify(executedSql);
    expect(serialized).toContain('usage_records');
    expect(serialized).toContain('cache_read_tokens');
    expect(serialized).not.toContain('pipeline_run_step_durations');
  });

  it('bucket=hour produces days*24 buckets', async () => {
    authVerified();
    accessAsOwner();
    queryQueue.push([]);
    const res = await buildApp().request(url('cost', '&days=2&bucket=hour'), {
      headers: { authorization: `Bearer ${await token()}` },
    });
    const body = (await res.json()) as { bucket: string; series: unknown[] };
    expect(body.bucket).toBe('hour');
    expect(body.series).toHaveLength(48);
  });
});
