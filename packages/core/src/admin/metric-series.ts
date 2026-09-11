/**
 * The console's metric machinery: the window vocabulary, the UTC bucket
 * boundaries, the bucketed SQL readers, and the one fold that turns them into a
 * series (ISS-975).
 *
 * Two surfaces are built from this and no other: `GET /overview`'s `glance`
 * tiles and `GET /metrics/:metric/timeseries`. Both go through
 * {@link computeSeries}, so a spark is provably a sample of the series the
 * route returns rather than a parallel computation of it. All window cutoffs
 * are bound SQL-side (`now() - (n::int * interval ...)`) — postgres-js cannot
 * serialize a JS Date at Bind time (ISS-267) — and bucket boundaries are
 * computed in JS so every series is dense regardless of which buckets have rows.
 */

import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bucketIso, utcDateTrunc } from '../lib/time-buckets.js';
import type { AdminGlanceMetric, AdminGlanceMetricName, AdminMetricSeriesPoint } from './types.js';

// cm:edge naming -> packages/core/src/mcp/tools/forge-metrics.ts — `project_timeseries` is the OTHER time-series surface and deliberately shares NO computation with this one: different metric names (cost|throughput|cycle_time|queue_wait|runner_utilization|cache_hit_rate), different window vocabulary (days 1..90 + bucket day|hour), different fence (project membership vs ADMIN_EMAILS) and different scope (one project vs cross-tenant). Neither is canonical; a shared fold would have to reconcile four disagreements to serve two callers.

export const windows = ['24h', '7d', '30d'] as const;
export type Window = (typeof windows)[number];

export type BucketUnit = 'hour' | 'day' | 'week';

export interface WindowSpec {
  hours: number;
  unit: BucketUnit;
  bucketCount: number;
}

export const WINDOW_SPECS: Record<Window, WindowSpec> = {
  '24h': { hours: 24, unit: 'hour', bucketCount: 24 },
  '7d': { hours: 24 * 7, unit: 'day', bucketCount: 7 },
  '30d': { hours: 24 * 30, unit: 'day', bucketCount: 30 },
};

export function cutoffExpr(hours: number): SQL {
  return sql`now() - (${hours}::int * interval '1 hour')`;
}

function bucketStepMs(unit: BucketUnit): number {
  if (unit === 'hour') return 3_600_000;
  if (unit === 'day') return 86_400_000;
  return 7 * 86_400_000;
}

/** Dense, oldest→newest UTC bucket-start boundaries for `count` buckets of
 *  `unit`, ending at the bucket containing `now`. Week buckets floor to UTC
 *  Monday to match `utcDateTrunc('week', ...)`. */
// cm:edge contract -> packages/core/src/lib/time-buckets.ts#utcDateTrunc — both sides floor in UTC or `toBucketMap` joins nothing and every glance reads zero
export function bucketBoundaries(unit: BucketUnit, count: number, now: Date): string[] {
  const end = new Date(now);
  end.setUTCMilliseconds(0);
  end.setUTCSeconds(0);
  end.setUTCMinutes(0);
  if (unit !== 'hour') end.setUTCHours(0);
  if (unit === 'week') {
    // cm:why remaps JS's Sun=0..Sat=6 to ISO Mon=0..Sun=6 so the floor below lands on Monday, matching Postgres date_trunc('week', ...)
    const isoDay = (end.getUTCDay() + 6) % 7;
    end.setUTCDate(end.getUTCDate() - isoDay);
  }
  const step = bucketStepMs(unit);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(new Date(end.getTime() - i * step).toISOString());
  return out;
}

export function toBucketMap(
  rows: Array<Record<string, unknown>>,
  key: string,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(bucketIso(r.bucket), Number(r[key] ?? 0));
  return m;
}

export function deltaPct(cur: number | null, prev: number | null): number | null {
  if (cur == null || prev == null || prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}

async function bucketedUserSignups(spec: WindowSpec, baseStart: SQL): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    SELECT ${utcDateTrunc(spec.unit, sql`created_at`)} AS bucket, count(*)::int AS n
    FROM users
    WHERE created_at >= ${baseStart}
    GROUP BY 1
  `)) as unknown as Array<{ bucket: unknown; n: number }>;
  return toBucketMap(rows, 'n');
}

async function bucketedLeadTime(
  spec: WindowSpec,
  baseStart: SQL,
): Promise<{ num: Map<string, number>; den: Map<string, number> }> {
  const rows = (await db.execute(sql`
    SELECT ${utcDateTrunc(spec.unit, sql`al.created_at`)} AS bucket,
           sum(extract(epoch from (al.created_at - i.created_at)) / 60.0)::float AS num,
           count(*)::int AS den
    FROM activity_log al
    INNER JOIN issues i ON i.id = al.issue_id
    WHERE al.action = 'issue.statusChanged'
      AND al.payload ->> 'to' IN ('in_progress', 'approved')
      AND al.created_at = (
        SELECT min(al2.created_at) FROM activity_log al2
        WHERE al2.issue_id = al.issue_id
          AND al2.action = 'issue.statusChanged'
          AND al2.payload ->> 'to' IN ('in_progress', 'approved')
      )
      AND al.created_at >= ${baseStart}
    GROUP BY 1
  `)) as unknown as Array<{ bucket: unknown; num: number | null; den: number }>;
  return { num: toBucketMap(rows, 'num'), den: toBucketMap(rows, 'den') };
}

// cm:guard reads BOTH `released` and `awaiting_release` because `activity_log` is HISTORY: 4,488 rows were written while the rung was called `released` (renamed 2026-09-10, migration 0228) and no migration rewrites them — a payload records what the status was called when it happened. Drop either spelling and the figure silently loses one side of that date.
async function bucketedResolved(spec: WindowSpec, baseStart: SQL): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    SELECT ${utcDateTrunc(spec.unit, sql`created_at`)} AS bucket, count(*)::int AS n
    FROM activity_log
    WHERE action = 'issue.statusChanged'
      AND payload ->> 'to' IN ('closed', 'released', 'awaiting_release')
      AND created_at >= ${baseStart}
    GROUP BY 1
  `)) as unknown as Array<{ bucket: unknown; n: number }>;
  return toBucketMap(rows, 'n');
}

// cm:guard match label lanes by NAME, never by id — `labels` rows are project-scoped and this query is cross-tenant, so the same lane is a different id in every workspace.
async function bucketedResolvedWithInterventionLabel(
  spec: WindowSpec,
  baseStart: SQL,
  lanes: string[],
): Promise<Map<string, number>> {
  if (lanes.length === 0) return new Map();
  const laneList = sql.join(
    lanes.map((name) => sql`${name}`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT ${utcDateTrunc(spec.unit, sql`al.created_at`)} AS bucket, count(DISTINCT al.id)::int AS n
    FROM activity_log al
    INNER JOIN issue_labels il ON il.issue_id = al.issue_id
    INNER JOIN labels l ON l.id = il.label_id
    WHERE al.action = 'issue.statusChanged'
      AND al.payload ->> 'to' IN ('closed', 'released', 'awaiting_release')
      AND l.name IN (${laneList})
      AND al.created_at >= ${baseStart}
    GROUP BY 1
  `)) as unknown as Array<{ bucket: unknown; n: number }>;
  return toBucketMap(rows, 'n');
}

async function bucketedCost(spec: WindowSpec, baseStart: SQL): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    SELECT ${utcDateTrunc(spec.unit, sql`recorded_at`)} AS bucket, coalesce(sum(estimated_cost), 0)::float AS n
    FROM usage_records
    WHERE recorded_at >= ${baseStart}
    GROUP BY 1
  `)) as unknown as Array<{ bucket: unknown; n: number }>;
  return toBucketMap(rows, 'n');
}

async function bucketedRunOutcomes(
  spec: WindowSpec,
  baseStart: SQL,
): Promise<{ num: Map<string, number>; den: Map<string, number> }> {
  const rows = (await db.execute(sql`
    SELECT ${utcDateTrunc(spec.unit, sql`started_at`)} AS bucket,
           count(*) FILTER (WHERE status = 'completed')::int AS num,
           count(*) FILTER (WHERE status IN ('completed', 'failed', 'cancelled'))::int AS den
    FROM pipeline_runs
    WHERE started_at >= ${baseStart}
    GROUP BY 1
  `)) as unknown as Array<{ bucket: unknown; num: number; den: number }>;
  return { num: toBucketMap(rows, 'num'), den: toBucketMap(rows, 'den') };
}

/** The numerator, the optional denominator, and the factor applied to a ratio.
 *  `den: null` is a plain count — no bucket of it is ever null. */
export interface MetricInput {
  num: Map<string, number>;
  den: Map<string, number> | null;
  scale: number;
}

/** The bucketed readers, each run at most once per request. */
export interface RawLoaders {
  signups: () => Promise<Map<string, number>>;
  leadTime: () => Promise<{ num: Map<string, number>; den: Map<string, number> }>;
  resolved: () => Promise<Map<string, number>>;
  resolvedWithLabel: () => Promise<Map<string, number>>;
  cost: () => Promise<Map<string, number>>;
  runOutcomes: () => Promise<{ num: Map<string, number>; den: Map<string, number> }>;
}

// cm:guard memoised because `resolved` is the DENOMINATOR of two metrics — `/overview` builds all five and would otherwise run that query twice. The memo is per-call and holds the promise, not the result, so two metrics awaiting it concurrently still share one round trip.
export function createRawLoaders(spec: WindowSpec, baseStart: SQL, lanes: string[]): RawLoaders {
  const memo = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const hit = memo.get(key);
    if (hit) return hit as Promise<T>;
    const fresh = load();
    memo.set(key, fresh);
    return fresh;
  };
  return {
    signups: () => once('signups', () => bucketedUserSignups(spec, baseStart)),
    leadTime: () => once('leadTime', () => bucketedLeadTime(spec, baseStart)),
    resolved: () => once('resolved', () => bucketedResolved(spec, baseStart)),
    resolvedWithLabel: () =>
      once('resolvedWithLabel', () =>
        bucketedResolvedWithInterventionLabel(spec, baseStart, lanes),
      ),
    cost: () => once('cost', () => bucketedCost(spec, baseStart)),
    runOutcomes: () => once('runOutcomes', () => bucketedRunOutcomes(spec, baseStart)),
  };
}

// cm:guard keyed by AdminGlanceMetricName, so this registry and `AdminOverview['glance']` cannot disagree about what the console measures (ISS-975) — the whole point of the shared union. A metric reachable at the series route that the glance cannot show, or the reverse, is the drift the type error prevents.
export const METRIC_SOURCES: Record<
  AdminGlanceMetricName,
  (raw: RawLoaders) => Promise<MetricInput>
> = {
  leadTimeMinutes: async (raw) => {
    const { num, den } = await raw.leadTime();
    return { num, den, scale: 1 };
  },
  interventionsPerClosed: async (raw) => {
    const [num, den] = await Promise.all([raw.resolvedWithLabel(), raw.resolved()]);
    return { num, den, scale: 1 };
  },
  costPerClosedUsd: async (raw) => {
    const [num, den] = await Promise.all([raw.cost(), raw.resolved()]);
    return { num, den, scale: 1 };
  },
  successRatePct: async (raw) => {
    const { num, den } = await raw.runOutcomes();
    return { num, den, scale: 100 };
  },
  signupsWindow: async (raw) => ({ num: await raw.signups(), den: null, scale: 1 }),
};

export interface MetricSeries {
  points: AdminMetricSeriesPoint[];
  value: number | null;
  baseline: number | null;
  spark: number[];
}

/**
 * The dense series over the baseline window AND the current one, plus the two
 * scalars the glance shows, folded in one pass.
 *
 * The `points` array is what `/metrics/:metric/timeseries` returns; `spark` is
 * its current-window tail with null read as zero. That is the same number the
 * glance published before the two were one computation, and reading it off the
 * points is what keeps the tile a sample of the series rather than a second
 * opinion about it.
 */
export function computeSeries(input: MetricInput, spec: WindowSpec, now: Date): MetricSeries {
  const curCutoffMs = now.getTime() - spec.hours * 3_600_000;
  const boundaries = bucketBoundaries(spec.unit, spec.bucketCount * 2, now);

  let curNum = 0;
  let curDen = 0;
  let baseNum = 0;
  let baseDen = 0;

  const points = boundaries.map((bucketStart) => {
    const num = input.num.get(bucketStart) ?? 0;
    const den = input.den ? (input.den.get(bucketStart) ?? 0) : 1;
    if (new Date(bucketStart).getTime() >= curCutoffMs) {
      curNum += num;
      curDen += den;
    } else {
      baseNum += num;
      baseDen += den;
    }
    // cm:guard a ratio bucket with a zero denominator is `null` — "nobody closed anything in this hour", which an operator reading a shape must be able to tell from a ratio that really was zero. A count bucket with no rows is 0, never null: the absence IS the measurement there.
    const value = input.den ? (den > 0 ? (num / den) * input.scale : null) : num * input.scale;
    return { bucketStart, value };
  });

  const fold = (n: number, d: number): number | null => {
    if (!input.den) return n * input.scale;
    return d > 0 ? (n / d) * input.scale : null;
  };

  const spark = points.slice(-spec.bucketCount).map((p) => p.value ?? 0);
  return { points, value: fold(curNum, curDen), baseline: fold(baseNum, baseDen), spark };
}

export function toGlance(series: MetricSeries): AdminGlanceMetric {
  return {
    value: series.value,
    deltaPct: deltaPct(series.value, series.baseline),
    spark: series.spark,
  };
}
