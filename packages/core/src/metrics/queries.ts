import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * Project-scoped time-series metrics. The SQL idioms here mirror
 * `src/projects/health-routes.ts` and `src/mcp/tools/forge-metrics.ts`:
 *   - window cutoffs are computed SQL-side as `now() - (${days}::int * interval
 *     '1 day')` because postgres-js cannot bind a JS `Date` into a parameterized
 *     query (ISS-267).
 *   - `bucket` ('day' | 'hour') is a BOUND text parameter, never
 *     string-interpolated, so it is injection-safe even though it is
 *     enum-validated upstream.
 *   - every bucket is floored as
 *     `date_trunc(bucket, ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'` — see the
 *     guard on {@link bucketTimestamps} for what a bare `date_trunc` costs.
 *   - percentiles use `percentile_disc(p) WITHIN GROUP (ORDER BY …)`.
 */

export const METRICS = [
  'cost',
  'throughput',
  'cycle_time',
  'queue_wait',
  'runner_utilization',
  'cache_hit_rate',
  'pass_rate', // issue_step_contexts.verdict, step='test'
  'approve_rate', // issue_step_contexts.verdict, step='review'
  'queue_depth', // queue_snapshots (sweeper-written)
  'runner_uptime', // runner_events (status-change audit)
] as const;
export type Metric = (typeof METRICS)[number];

export const BUCKETS = ['day', 'hour'] as const;
export type Bucket = (typeof BUCKETS)[number];

const BUCKET_SECONDS: Record<Bucket, number> = { day: 86_400, hour: 3_600 };
const BUCKET_MS: Record<Bucket, number> = { day: 86_400_000, hour: 3_600_000 };

function num(x: unknown): number {
  if (x === null || x === undefined) return 0;
  return typeof x === 'number' ? x : Number(x);
}

/** Normalize a `date_trunc` bucket value (Date | string from the driver) to ISO. */
function bucketIso(x: unknown): string {
  if (x instanceof Date) return x.toISOString();
  return new Date(x as string).toISOString();
}

function windowCutoff(days: number): SQL {
  return sql`now() - (${days}::int * interval '1 day')`;
}

/**
 * The ordered list of bucket-boundary ISO timestamps the window should contain,
 * computed in JS so the response is dense (gap-filled) regardless of which
 * buckets had rows. Daily buckets are floored to UTC midnight, hourly to the
 * hour. `now` is injectable for deterministic tests.
 */
// cm:guard the SQL side of every bucketed query in this file truncates as `date_trunc(unit, ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, and the two halves have to agree or the join below silently finds nothing. `ts` columns are `timestamptz` and bare `date_trunc` floors them in the SESSION timezone, while this function floors in UTC — so on any connection whose timezone is not UTC every key here misses every SQL key, `densifyScalar` fills the defaults, and the route answers a well-formed series of zeros with no error anywhere. Measured on a `Asia/Ho_Chi_Minh` session: a row at 21:00Z bucketed to 17:00Z and matched nothing. Do NOT fix that by setting the session timezone instead: a transaction-mode pooler drops session SETs, which turns this back into the silent version.
export function bucketTimestamps(days: number, bucket: Bucket, now: Date): string[] {
  const end = new Date(now);
  end.setUTCMilliseconds(0);
  end.setUTCSeconds(0);
  end.setUTCMinutes(0);
  if (bucket === 'day') end.setUTCHours(0);
  const count = bucket === 'day' ? days : days * 24;
  const step = BUCKET_MS[bucket];
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push(new Date(end.getTime() - i * step).toISOString());
  }
  return out;
}

export interface TimeseriesPoint {
  ts: string;
  [key: string]: unknown;
}

/** Build a dense scalar series: one point per bucket, missing buckets filled with `defaults`. */
function densifyScalar(
  buckets: string[],
  rows: Array<Record<string, unknown>>,
  map: (row: Record<string, unknown>) => Omit<TimeseriesPoint, 'ts'>,
  defaults: Omit<TimeseriesPoint, 'ts'>,
): TimeseriesPoint[] {
  const byBucket = new Map<string, Omit<TimeseriesPoint, 'ts'>>();
  for (const r of rows) byBucket.set(bucketIso(r.bucket), map(r));
  return buckets.map((ts) => ({ ts, ...defaults, ...(byBucket.get(ts) ?? {}) }));
}

/**
 * Build a dense series for a metric grouped by an extra dimension (cost-by-step,
 * runner_utilization). Each distinct dimension value gets its own full set of
 * buckets so a chart can plot one line per dimension without holes.
 */
function densifyGrouped(
  buckets: string[],
  rows: Array<Record<string, unknown>>,
  dimKey: string,
  map: (row: Record<string, unknown>) => Omit<TimeseriesPoint, 'ts'>,
  defaults: Omit<TimeseriesPoint, 'ts'>,
): TimeseriesPoint[] {
  const dims = [...new Set(rows.map((r) => String(r[dimKey])))].sort();
  const byKey = new Map<string, Omit<TimeseriesPoint, 'ts'>>();
  for (const r of rows) byKey.set(`${bucketIso(r.bucket)}|${String(r[dimKey])}`, map(r));
  const out: TimeseriesPoint[] = [];
  for (const dim of dims) {
    for (const ts of buckets) {
      out.push({
        ts,
        [dimKey]: dim,
        ...defaults,
        ...(byKey.get(`${ts}|${dim}`) ?? {}),
      });
    }
  }
  return out;
}

export interface TimeseriesParams {
  projectId: string;
  metric: Metric;
  days: number;
  bucket: Bucket;
  groupByStep: boolean;
  now?: Date;
}

export interface TimeseriesResult {
  metric: Metric;
  bucket: Bucket;
  days: number;
  groupBy: 'step' | null;
  series: TimeseriesPoint[];
}

/**
 * Run the aggregation for one metric and return a dense, chart-ready series.
 * Read-only; every query is bounded by the `days` window (capped 1..90 by the
 * caller's zod schema) and scoped to a single project id.
 */
export async function runTimeseries(params: TimeseriesParams): Promise<TimeseriesResult> {
  const { projectId, metric, days, bucket } = params;
  const groupByStep = params.groupByStep && metric === 'cost';
  const cutoff = windowCutoff(days);
  const buckets = bucketTimestamps(days, bucket, params.now ?? new Date());
  let series: TimeseriesPoint[] = [];

  switch (metric) {
    case 'cost': {
      if (groupByStep) {
        const rows = (await db.execute(sql`
          SELECT date_trunc(${bucket}, started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
                 step,
                 sum(cost_usd)::float AS cost_usd
          FROM pipeline_run_step_durations
          WHERE project_id = ${projectId}
            AND started_at >= ${cutoff}
          GROUP BY 1, step
          ORDER BY 1, step
        `)) as unknown as Array<Record<string, unknown>>;
        series = densifyGrouped(buckets, rows, 'step', (r) => ({ costUsd: num(r.cost_usd) }), {
          costUsd: 0,
        });
      } else {
        const rows = (await db.execute(sql`
          SELECT date_trunc(${bucket}, recorded_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
                 sum(estimated_cost)::float AS cost_usd
          FROM usage_records
          WHERE project_id = ${projectId}
            AND recorded_at >= ${cutoff}
          GROUP BY 1
          ORDER BY 1
        `)) as unknown as Array<Record<string, unknown>>;
        series = densifyScalar(buckets, rows, (r) => ({ costUsd: num(r.cost_usd) }), {
          costUsd: 0,
        });
      }
      break;
    }

    case 'throughput': {
      const rows = (await db.execute(sql`
        SELECT date_trunc(${bucket}, al.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
               count(*)::int AS resolved
        FROM activity_log al
        JOIN issues i ON i.id = al.issue_id
        WHERE i.project_id = ${projectId}
          AND al.action = 'issue.statusChanged'
          AND al.payload ->> 'to' IN ('closed', 'released')
          AND al.created_at >= ${cutoff}
        GROUP BY 1
        ORDER BY 1
      `)) as unknown as Array<Record<string, unknown>>;
      const dense = densifyScalar(buckets, rows, (r) => ({ resolved: num(r.resolved) }), {
        resolved: 0,
      });
      // Cumulative (burndown) = running sum of resolved across the window.
      let acc = 0;
      series = dense.map((p) => {
        acc += num(p.resolved);
        return { ...p, cumulative: acc };
      });
      break;
    }

    case 'cycle_time': {
      // Work-start = first transition into in_progress/approved (ISS-380 AC #3),
      // NOT issues.created_at. Falls back to created_at for issues that predate
      // those transitions so older resolved issues still contribute.
      const rows = (await db.execute(sql`
        WITH resolved AS (
          SELECT al.issue_id,
                 max(al.created_at) AS resolved_at
          FROM activity_log al
          JOIN issues i ON i.id = al.issue_id
          WHERE i.project_id = ${projectId}
            AND al.action = 'issue.statusChanged'
            AND al.payload ->> 'to' IN ('closed', 'released')
            AND al.created_at >= ${cutoff}
          GROUP BY al.issue_id
        ),
        work_start AS (
          SELECT al.issue_id, min(al.created_at) AS started_at
          FROM activity_log al
          WHERE al.action = 'issue.statusChanged'
            AND al.payload ->> 'to' IN ('in_progress', 'approved')
          GROUP BY al.issue_id
        )
        SELECT date_trunc(${bucket}, r.resolved_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
               avg(extract(epoch from (r.resolved_at - COALESCE(ws.started_at, i.created_at))) / 86400.0)::float AS avg_days,
               percentile_disc(0.5) WITHIN GROUP (
                 ORDER BY extract(epoch from (r.resolved_at - COALESCE(ws.started_at, i.created_at))) / 86400.0
               ) AS p50_days,
               count(*)::int AS n
        FROM resolved r
        JOIN issues i ON i.id = r.issue_id
        LEFT JOIN work_start ws ON ws.issue_id = r.issue_id
        GROUP BY 1
        ORDER BY 1
      `)) as unknown as Array<Record<string, unknown>>;
      series = densifyScalar(
        buckets,
        rows,
        (r) => ({ avgDays: num(r.avg_days), p50Days: num(r.p50_days), n: num(r.n) }),
        { avgDays: 0, p50Days: 0, n: 0 },
      );
      break;
    }

    case 'queue_wait': {
      const rows = (await db.execute(sql`
        SELECT date_trunc(${bucket}, queued_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
               percentile_disc(0.5) WITHIN GROUP (
                 ORDER BY extract(epoch from (dispatched_at - queued_at)) * 1000.0
               ) AS median_ms,
               percentile_disc(0.95) WITHIN GROUP (
                 ORDER BY extract(epoch from (dispatched_at - queued_at)) * 1000.0
               ) AS p95_ms,
               count(*)::int AS n
        FROM jobs
        WHERE project_id = ${projectId}
          AND dispatched_at IS NOT NULL
          AND queued_at >= ${cutoff}
        GROUP BY 1
        ORDER BY 1
      `)) as unknown as Array<Record<string, unknown>>;
      series = densifyScalar(
        buckets,
        rows,
        (r) => ({ medianMs: num(r.median_ms), p95Ms: num(r.p95_ms), n: num(r.n) }),
        { medianMs: 0, p95Ms: 0, n: 0 },
      );
      break;
    }

    case 'runner_utilization': {
      // jobs has no started_at; dispatched_at is the busy-interval start proxy.
      const windowSeconds = BUCKET_SECONDS[bucket];
      const rows = (await db.execute(sql`
        SELECT date_trunc(${bucket}, dispatched_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
               runner_id,
               (sum(extract(epoch from (finished_at - dispatched_at))) / ${windowSeconds}::float) AS busy_pct
        FROM jobs
        WHERE project_id = ${projectId}
          AND runner_id IS NOT NULL
          AND dispatched_at IS NOT NULL
          AND finished_at IS NOT NULL
          AND dispatched_at >= ${cutoff}
        GROUP BY 1, runner_id
        ORDER BY 1, runner_id
      `)) as unknown as Array<Record<string, unknown>>;
      series = densifyGrouped(
        buckets,
        rows,
        'runner_id',
        (r) => ({ busyPct: Math.min(1, Math.max(0, num(r.busy_pct))) }),
        { busyPct: 0 },
      ).map((p) => ({ ts: p.ts, runnerId: p.runner_id, busyPct: p.busyPct }));
      break;
    }

    case 'cache_hit_rate': {
      // Computed directly from usage_records (project-scoped, windowed, served by
      // the (project_id, recorded_at) index) rather than the
      // pipeline_run_step_durations view: the deployed view (0057 shape; 0128 —
      // ISS-516 — guards only duration_seconds, leaving the row set/cost_usd
      // untouched) keeps the 8-column contract and lacks the cache-token
      // columns (0075 was orphaned/never applied — it
      // references the dropped jobs.started_at — and is now deleted), so reading
      // cache_read_tokens off the view 500s on live (ISS-380 forge-test FAIL).
      // usage_records carries the same tokens.
      // total input = input_tokens + cache_read_tokens (cache reads are billed
      // input that bypassed fresh processing).
      const rows = (await db.execute(sql`
        SELECT date_trunc(${bucket}, recorded_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
               (sum(cache_read_tokens)::float / NULLIF(sum(input_tokens + cache_read_tokens), 0)) AS cache_hit_rate,
               count(*)::int AS n
        FROM usage_records
        WHERE project_id = ${projectId}
          AND recorded_at >= ${cutoff}
        GROUP BY 1
        ORDER BY 1
      `)) as unknown as Array<Record<string, unknown>>;
      series = densifyScalar(
        buckets,
        rows,
        (r) => ({
          cacheHitRate: r.cache_hit_rate == null ? null : num(r.cache_hit_rate),
          n: num(r.n),
        }),
        { cacheHitRate: null, n: 0 },
      );
      break;
    }

    case 'pass_rate':
    case 'approve_rate': {
      const isPassRate = metric === 'pass_rate';
      const step = isPassRate ? 'test' : 'review';
      const passed = isPassRate
        ? sql`verdict IN ('pass', 'verified_by_test')`
        : sql`verdict = 'pass'`;
      const eligible = isPassRate ? sql`verdict <> 'blocked_fixture'` : sql`true`;
      const rows = (await db.execute(sql`
        SELECT date_trunc(${bucket}, created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
               (count(*) FILTER (WHERE ${passed})::float / NULLIF(count(*) FILTER (WHERE ${eligible}), 0)) AS rate,
               (count(*) FILTER (WHERE ${eligible}))::int AS n
        FROM issue_step_contexts
        WHERE project_id = ${projectId}
          AND step = ${step}
          AND verdict IS NOT NULL
          AND created_at >= ${cutoff}
        GROUP BY 1
        ORDER BY 1
      `)) as unknown as Array<Record<string, unknown>>;
      series = densifyScalar(
        buckets,
        rows,
        (r) => ({ rate: r.rate == null ? null : num(r.rate), n: num(r.n) }),
        { rate: null, n: 0 },
      );
      break;
    }

    case 'queue_depth': {
      // ISS-381 (2.2) — sweeper-written snapshots. Average the per-tick depth /
      // running count within each bucket; gaps fill as 0 (no active jobs).
      const rows = (await db.execute(sql`
        SELECT date_trunc(${bucket}, ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
               avg(queue_depth)::float AS queue_depth,
               avg(running_count)::float AS running_count,
               avg(avg_wait_ms)::float AS avg_wait_ms
        FROM queue_snapshots
        WHERE project_id = ${projectId}
          AND ts >= ${cutoff}
        GROUP BY 1
        ORDER BY 1
      `)) as unknown as Array<Record<string, unknown>>;
      series = densifyScalar(
        buckets,
        rows,
        (r) => ({
          queueDepth: num(r.queue_depth),
          runningCount: num(r.running_count),
          avgWaitMs: r.avg_wait_ms == null ? null : num(r.avg_wait_ms),
        }),
        { queueDepth: 0, runningCount: 0, avgWaitMs: null },
      );
      break;
    }

    case 'runner_uptime': {
      // ISS-381 (2.3) — reconstruct each runner's online fraction per bucket from
      // the runner_events transition log. We fetch in-window events plus the
      // latest pre-window event per runner (the state entering the window), then
      // clip each online segment to bucket boundaries in JS — mirrors how
      // `throughput` computes its cumulative in JS rather than SQL.
      // The pre-window carry-in MUST be the LATEST event before the cutoff.
      // DISTINCT ON (runner_id) keeps the first row per runner only when the
      // query's OWN leftmost ORDER BY matches the DISTINCT ON expressions — a
      // trailing ORDER BY on the UNION does NOT bind to the sub-SELECT. So the
      // DISTINCT ON lives in its own ordered subquery; otherwise Postgres keeps
      // an arbitrary pre-cutoff event and the leading-edge onlinePct is wrong.
      const rows = (await db.execute(sql`
        SELECT runner_id, new_status, ts FROM runner_events
        WHERE project_id = ${projectId} AND ts >= ${cutoff}
        UNION ALL
        SELECT runner_id, new_status, ts FROM (
          SELECT DISTINCT ON (runner_id) runner_id, new_status, ts
          FROM runner_events
          WHERE project_id = ${projectId} AND ts < ${cutoff}
          ORDER BY runner_id, ts DESC
        ) carry
      `)) as unknown as Array<Record<string, unknown>>;
      series = computeRunnerUptime(buckets, rows, BUCKET_MS[bucket], params.now ?? new Date());
      break;
    }
  }

  return { metric, bucket, days, groupBy: groupByStep ? 'step' : null, series };
}

/**
 * ISS-381 (2.3) — compute per-(bucket × runner) online fraction from the raw
 * runner_events rows. Each row is `{ runner_id, new_status, ts }`; a runner holds
 * `new_status` from its `ts` until the next event (or `now`). Online segments are
 * clipped to each bucket window and summed; `onlinePct` is online-ms / bucket-ms,
 * clamped 0..1. Runners with no events in or before the window do not appear.
 */
export function computeRunnerUptime(
  buckets: string[],
  rows: Array<Record<string, unknown>>,
  bucketMs: number,
  now: Date,
): TimeseriesPoint[] {
  const nowMs = now.getTime();
  // Group events by runner, preserving ascending ts order.
  const byRunner = new Map<string, Array<{ status: string; ts: number }>>();
  for (const r of rows) {
    const runnerId = String(r.runner_id);
    const ts = r.ts instanceof Date ? r.ts.getTime() : new Date(r.ts as string).getTime();
    const list = byRunner.get(runnerId) ?? [];
    list.push({ status: String(r.new_status), ts });
    byRunner.set(runnerId, list);
  }

  const bucketStarts = buckets.map((b) => new Date(b).getTime());
  const out: TimeseriesPoint[] = [];

  for (const runnerId of [...byRunner.keys()].sort()) {
    const events = (byRunner.get(runnerId) ?? []).sort((a, b) => a.ts - b.ts);
    const onlineMs: number[] = new Array(bucketStarts.length).fill(0);

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev?.status !== 'online') continue;
      const segStart = ev.ts;
      const next = events[i + 1];
      const segEnd = next ? next.ts : nowMs;
      if (segEnd <= segStart) continue;
      for (let b = 0; b < bucketStarts.length; b++) {
        const bStart = bucketStarts[b];
        if (bStart === undefined) continue;
        const bEnd = bStart + bucketMs;
        const overlap = Math.min(segEnd, bEnd) - Math.max(segStart, bStart);
        if (overlap > 0) onlineMs[b] = (onlineMs[b] ?? 0) + overlap;
      }
    }

    for (let b = 0; b < bucketStarts.length; b++) {
      const ts = buckets[b];
      if (ts === undefined) continue;
      out.push({
        ts,
        runnerId,
        onlinePct: Math.min(1, Math.max(0, (onlineMs[b] ?? 0) / bucketMs)),
      });
    }
  }

  return out;
}

export type StepDurationAggRow = {
  project_id: string;
  project_slug: string | null;
  step: string;
  p50_s: number | string | null;
  p95_s: number | string | null;
  avg_s: number | string | null;
  total_cost: number | string | null;
  n: number | string | null;
};

export type ProjectStepDurationRow = Omit<StepDurationAggRow, 'project_id' | 'project_slug'> & {
  breakdown_key?: string | null;
};

export async function stepDurationsForProject(
  projectId: string,
  days: number,
  step?: string,
  breakdown?: 'device' | 'model',
): Promise<ProjectStepDurationRow[]> {
  const stepFilter = step ? sql`AND step = ${step}` : sql``;
  const breakdownCol =
    breakdown === 'device' ? sql`device_id` : breakdown === 'model' ? sql`model_used` : null;
  const breakdownSelect = breakdownCol ? sql`${breakdownCol} AS breakdown_key,` : sql``;
  const breakdownGroup = breakdownCol ? sql`, ${breakdownCol}` : sql``;
  const result = await db.execute(sql`
    SELECT step,
           ${breakdownSelect}
           percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_seconds) AS p50_s,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_seconds) AS p95_s,
           avg(duration_seconds)::float AS avg_s,
           sum(cost_usd)::float AS total_cost,
           count(duration_seconds)::int AS n
    FROM pipeline_run_step_durations
    WHERE project_id = ${projectId}
      AND started_at >= now() - (${days}::int * interval '1 day')
      ${stepFilter}
    GROUP BY step${breakdownGroup}
    ORDER BY step
  `);
  return result as unknown as ProjectStepDurationRow[];
}

export type RetryRescueRow = {
  failure_kind: string | null;
  failure_reason: string;
  rescues: number | string;
  last_rescued_at: string | Date;
};

export async function retryRescues(projectId: string, days: number): Promise<RetryRescueRow[]> {
  const result = await db.execute(sql`
    SELECT failure_kind, failure_reason, count(*)::int AS rescues,
           max(rescued_at) AS last_rescued_at
    FROM retry_rescues
    WHERE project_id = ${projectId}
      AND rescued_at >= now() - (${days}::int * interval '1 day')
    GROUP BY failure_kind, failure_reason
    ORDER BY rescues DESC, last_rescued_at DESC
  `);
  return result as unknown as RetryRescueRow[];
}

export type SessionFailureAggRow = {
  status: string | null;
  failure_reason: string | null;
  sessions: number | string;
  last_at: string | Date | null;
};

// cm:guard the OR is load-bearing: a session at any other status that still carries a `failure_reason` must come back too, so the caller can report it instead of dropping it. That is the ISS-759 completed-yet-failed shape plus the live rows the I1 trigger stamped, and narrowing this to the two failed statuses makes them invisible rather than absent.
export async function sessionFailures(
  projectId: string,
  days: number,
): Promise<SessionFailureAggRow[]> {
  const result = await db.execute(sql`
    SELECT status, failure_reason, count(*)::int AS sessions, max(updated_at) AS last_at
    FROM agent_sessions
    WHERE project_id = ${projectId}
      AND updated_at >= now() - (${days}::int * interval '1 day')
      AND (status IN ('failed', 'cancelled_stale') OR failure_reason IS NOT NULL)
    GROUP BY status, failure_reason
  `);
  return result as unknown as SessionFailureAggRow[];
}

export type ResumeDropRow = { drop_reason: string | null; sessions: number | string };

// cm:guard `priorClaudeSessionId IS NOT NULL` is what defines the denominator, and it must stay in the WHERE rather than move to the caller. It is what keeps attempt 1 out: an attempt with no prior session to continue is the normal shape of a first try, and folding those in makes the drop rate shrink as the project does MORE fresh work.
// cm:guard this must NOT inherit the failure histogram's status filter. A resume is dropped on healthy dispatches too — restricting it to `failed`/`cancelled_stale` would measure the drop rate of attempts that later died, report it as the drop rate, and leave both numbers wrong.
export async function resumeDropsForProject(
  projectId: string,
  days: number,
): Promise<ResumeDropRow[]> {
  const result = await db.execute(sql`
    SELECT metadata->'resume'->>'dropReason' AS drop_reason, count(*)::int AS sessions
    FROM agent_sessions
    WHERE project_id = ${projectId}
      AND created_at >= now() - (${days}::int * interval '1 day')
      AND metadata->'resume'->>'priorClaudeSessionId' IS NOT NULL
    GROUP BY 1
  `);
  return result as unknown as ResumeDropRow[];
}
