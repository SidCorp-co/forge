/**
 * Admin cross-tenant aggregate endpoints for the Operator Ops Console (Step 1,
 * ISS-651): GET /overview, /adoption, /workspaces. Own requireAdmin gate (like
 * `pipeline-health-routes.ts`) so this router can be imported standalone in a
 * vitest suite. All window cutoffs are bound SQL-side (`now() - (n::int *
 * interval ...)`) — postgres-js cannot serialize a JS Date at Bind time
 * (ISS-267) — and bucket boundaries are computed in JS (mirrors
 * `metrics/queries.ts`) so every series is dense regardless of which buckets
 * have rows.
 */

import { zValidator } from '@hono/zod-validator';
import { type SQL, and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  devices,
  issues,
  jobs,
  organizations,
  pipelineRuns,
  projects,
  usageRecords,
  users,
} from '../db/schema.js';
import { setTotalCount } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

// cm:hack ISS-649 until:admin-thresholds-config-lands — G2 label lanes hardcoded here; Step 4 (thresholds config) replaces with configurable slugs. Labels are project-scoped, so cross-tenant matching is by NAME, not id.
const INTERVENTION_LABEL_LANES = ['kernel-hardening', 'onboarding'] as const;

// cm:edge naming -> packages/core/src/projects/health-routes.ts — mirrors NON_OPEN_STATUSES there; keep the excluded-status set aligned
const NON_OPEN_STATUSES = new Set(['released', 'closed', 'draft']);

const windows = ['24h', '7d', '30d'] as const;
type Window = (typeof windows)[number];

type BucketUnit = 'hour' | 'day' | 'week';

interface WindowSpec {
  hours: number;
  unit: BucketUnit;
  bucketCount: number;
}

const WINDOW_SPECS: Record<Window, WindowSpec> = {
  '24h': { hours: 24, unit: 'hour', bucketCount: 24 },
  '7d': { hours: 24 * 7, unit: 'day', bucketCount: 7 },
  '30d': { hours: 24 * 30, unit: 'day', bucketCount: 30 },
};

function cutoffExpr(hours: number): SQL {
  return sql`now() - (${hours}::int * interval '1 hour')`;
}

function bucketStepMs(unit: BucketUnit): number {
  if (unit === 'hour') return 3_600_000;
  if (unit === 'day') return 86_400_000;
  return 7 * 86_400_000;
}

/** Dense, oldest→newest UTC bucket-start boundaries for `count` buckets of
 *  `unit`, ending at the bucket containing `now`. Week buckets floor to UTC
 *  Monday to match Postgres `date_trunc('week', ...)`. */
function bucketBoundaries(unit: BucketUnit, count: number, now: Date): string[] {
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

function bucketIso(x: unknown): string {
  return x instanceof Date ? x.toISOString() : new Date(x as string).toISOString();
}

function toBucketMap(rows: Array<Record<string, unknown>>, key: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(bucketIso(r.bucket), Number(r[key] ?? 0));
  return m;
}

/** Combine per-bucket {value: number} rows into a windowed sum + baseline sum
 *  + dense current-window spark. For plain counts (not ratios) — e.g. signups. */
function countGlance(
  numByBucket: Map<string, number>,
  spec: WindowSpec,
  now: Date,
): { value: number; baseline: number; spark: number[] } {
  const curCutoffMs = now.getTime() - spec.hours * 3_600_000;
  const fullBuckets = bucketBoundaries(spec.unit, spec.bucketCount * 2, now);
  let curSum = 0;
  let baseSum = 0;
  for (const ts of fullBuckets) {
    const n = numByBucket.get(ts) ?? 0;
    if (new Date(ts).getTime() >= curCutoffMs) curSum += n;
    else baseSum += n;
  }
  const curBuckets = bucketBoundaries(spec.unit, spec.bucketCount, now);
  const spark = curBuckets.map((ts) => numByBucket.get(ts) ?? 0);
  return { value: curSum, baseline: baseSum, spark };
}

/** Combine per-bucket {num, den} rows into a windowed ratio (num/den) + baseline
 *  ratio + dense current-window spark ratio. Used for averages (lead time) and
 *  proportions (intervention rate, cost/closed, success rate). */
function ratioGlance(
  numByBucket: Map<string, number>,
  denByBucket: Map<string, number>,
  spec: WindowSpec,
  now: Date,
): { value: number | null; baseline: number | null; spark: number[] } {
  const curCutoffMs = now.getTime() - spec.hours * 3_600_000;
  const fullBuckets = bucketBoundaries(spec.unit, spec.bucketCount * 2, now);
  let curNum = 0;
  let curDen = 0;
  let baseNum = 0;
  let baseDen = 0;
  for (const ts of fullBuckets) {
    const num = numByBucket.get(ts) ?? 0;
    const den = denByBucket.get(ts) ?? 0;
    if (new Date(ts).getTime() >= curCutoffMs) {
      curNum += num;
      curDen += den;
    } else {
      baseNum += num;
      baseDen += den;
    }
  }
  const value = curDen > 0 ? curNum / curDen : null;
  const baseline = baseDen > 0 ? baseNum / baseDen : null;
  const curBuckets = bucketBoundaries(spec.unit, spec.bucketCount, now);
  const spark = curBuckets.map((ts) => {
    const den = denByBucket.get(ts) ?? 0;
    return den > 0 ? (numByBucket.get(ts) ?? 0) / den : 0;
  });
  return { value, baseline, spark };
}

function deltaPct(cur: number | null, prev: number | null): number | null {
  if (cur == null || prev == null || prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}

interface GlanceMetric {
  value: number | null;
  deltaPct: number | null;
  spark: number[];
}

function toGlance(r: {
  value: number | null;
  baseline: number | null;
  spark: number[];
}): GlanceMetric {
  return { value: r.value, deltaPct: deltaPct(r.value, r.baseline), spark: r.spark };
}

async function bucketedUserSignups(spec: WindowSpec, baseStart: SQL): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    SELECT date_trunc(${spec.unit}, created_at) AS bucket, count(*)::int AS n
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
    SELECT date_trunc(${spec.unit}, al.created_at) AS bucket,
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

async function bucketedResolved(spec: WindowSpec, baseStart: SQL): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    SELECT date_trunc(${spec.unit}, created_at) AS bucket, count(*)::int AS n
    FROM activity_log
    WHERE action = 'issue.statusChanged'
      AND payload ->> 'to' IN ('closed', 'released')
      AND created_at >= ${baseStart}
    GROUP BY 1
  `)) as unknown as Array<{ bucket: unknown; n: number }>;
  return toBucketMap(rows, 'n');
}

async function bucketedResolvedWithInterventionLabel(
  spec: WindowSpec,
  baseStart: SQL,
): Promise<Map<string, number>> {
  const laneList = sql.join(
    INTERVENTION_LABEL_LANES.map((name) => sql`${name}`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT date_trunc(${spec.unit}, al.created_at) AS bucket, count(DISTINCT al.id)::int AS n
    FROM activity_log al
    INNER JOIN issue_labels il ON il.issue_id = al.issue_id
    INNER JOIN labels l ON l.id = il.label_id
    WHERE al.action = 'issue.statusChanged'
      AND al.payload ->> 'to' IN ('closed', 'released')
      AND l.name IN (${laneList})
      AND al.created_at >= ${baseStart}
    GROUP BY 1
  `)) as unknown as Array<{ bucket: unknown; n: number }>;
  return toBucketMap(rows, 'n');
}

async function bucketedCost(spec: WindowSpec, baseStart: SQL): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    SELECT date_trunc(${spec.unit}, recorded_at) AS bucket, coalesce(sum(estimated_cost), 0)::float AS n
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
    SELECT date_trunc(${spec.unit}, started_at) AS bucket,
           count(*) FILTER (WHERE status = 'completed')::int AS num,
           count(*) FILTER (WHERE status IN ('completed', 'failed', 'cancelled'))::int AS den
    FROM pipeline_runs
    WHERE started_at >= ${baseStart}
    GROUP BY 1
  `)) as unknown as Array<{ bucket: unknown; num: number; den: number }>;
  return { num: toBucketMap(rows, 'num'), den: toBucketMap(rows, 'den') };
}

export interface AdminOverview {
  counts: {
    users: number;
    usersNew: number;
    orgs: number;
    projects: number;
    activeWorkspaces: number;
    devicesOnline: number;
    devicesTotal: number;
  };
  kpis: {
    openAlerts: number;
    inFlightJobs: number;
    spendWindowUsd: number;
    spendBaselineUsd: number;
  };
  glance: {
    leadTimeMinutes: GlanceMetric;
    interventionsPerClosed: GlanceMetric;
    costPerClosedUsd: GlanceMetric;
    successRatePct: GlanceMetric;
    signupsWindow: GlanceMetric;
  };
}

export interface AdminAdoptionBucket {
  bucketStart: string;
  newUsers: number;
  cumulativeUsers: number;
  activeWorkspaces: number;
}

export interface AdminWorkspaceRow {
  projectId: string;
  slug: string;
  runs: number;
  spendUsd: number;
  medianLeadTimeMin: number | null;
  openIssues: number;
}

const overviewQuerySchema = z.object({ window: z.enum(windows).default('24h') });

export const adminAggregateRoutes = new Hono<{ Variables: AuthVars }>();
adminAggregateRoutes.use('*', requireAuth(), assertEmailVerified(), requireAdmin());

adminAggregateRoutes.get(
  '/overview',
  zValidator('query', overviewQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { window } = c.req.valid('query');
    const spec = WINDOW_SPECS[window];
    const now = new Date();
    const cutoff = cutoffExpr(spec.hours);
    const baseStart = cutoffExpr(spec.hours * 2);

    const [
      [{ n: usersTotal } = { n: 0 }],
      [{ n: orgsTotal } = { n: 0 }],
      [{ n: projectsTotal } = { n: 0 }],
      [{ n: activeWorkspaces } = { n: 0 }],
      [{ n: devicesOnline } = { n: 0 }],
      [{ n: devicesTotal } = { n: 0 }],
      [{ n: openAlerts } = { n: 0 }],
      [{ n: inFlightJobs } = { n: 0 }],
      [{ v: spendWindowUsd } = { v: 0 }],
      [{ v: spendBaselineUsd } = { v: 0 }],
      signupsByBucket,
      leadTime,
      resolved,
      resolvedWithLabel,
      cost,
      runOutcomes,
    ] = await Promise.all([
      db.select({ n: count() }).from(users),
      db.select({ n: count() }).from(organizations),
      db.select({ n: count() }).from(projects).where(isNull(projects.archivedAt)),
      db
        .select({ n: sql<number>`count(distinct ${pipelineRuns.projectId})::int` })
        .from(pipelineRuns)
        .where(sql`${pipelineRuns.startedAt} >= ${cutoff}`),
      db.select({ n: count() }).from(devices).where(eq(devices.status, 'online')),
      db.select({ n: count() }).from(devices),
      db
        .select({ n: count() })
        .from(jobs)
        .where(
          and(
            eq(jobs.status, 'running'),
            sql`${jobs.dispatchedAt} < now() - interval '600 seconds'`,
          ),
        ),
      db
        .select({ n: count() })
        .from(jobs)
        .where(inArray(jobs.status, ['queued', 'dispatched', 'running'])),
      db
        .select({ v: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)::float` })
        .from(usageRecords)
        .where(sql`${usageRecords.recordedAt} >= ${cutoff}`),
      db
        .select({ v: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)::float` })
        .from(usageRecords)
        .where(
          sql`${usageRecords.recordedAt} >= ${baseStart} AND ${usageRecords.recordedAt} < ${cutoff}`,
        ),
      bucketedUserSignups(spec, baseStart),
      bucketedLeadTime(spec, baseStart),
      bucketedResolved(spec, baseStart),
      bucketedResolvedWithInterventionLabel(spec, baseStart),
      bucketedCost(spec, baseStart),
      bucketedRunOutcomes(spec, baseStart),
    ]);

    const signups = countGlance(signupsByBucket, spec, now);
    const successRate = ratioGlance(runOutcomes.num, runOutcomes.den, spec, now);

    const overview: AdminOverview = {
      counts: {
        users: Number(usersTotal),
        usersNew: signups.value,
        orgs: Number(orgsTotal),
        projects: Number(projectsTotal),
        activeWorkspaces: Number(activeWorkspaces),
        devicesOnline: Number(devicesOnline),
        devicesTotal: Number(devicesTotal),
      },
      kpis: {
        openAlerts: Number(openAlerts),
        inFlightJobs: Number(inFlightJobs),
        spendWindowUsd: Number(spendWindowUsd),
        spendBaselineUsd: Number(spendBaselineUsd),
      },
      glance: {
        leadTimeMinutes: toGlance(ratioGlance(leadTime.num, leadTime.den, spec, now)),
        interventionsPerClosed: toGlance(ratioGlance(resolvedWithLabel, resolved, spec, now)),
        costPerClosedUsd: toGlance(ratioGlance(cost, resolved, spec, now)),
        successRatePct: toGlance({
          value: successRate.value != null ? successRate.value * 100 : null,
          baseline: successRate.baseline != null ? successRate.baseline * 100 : null,
          spark: successRate.spark.map((v) => v * 100),
        }),
        signupsWindow: toGlance({
          value: signups.value,
          baseline: signups.baseline,
          spark: signups.spark,
        }),
      },
    };

    return c.json(overview);
  },
);

const adoptionQuerySchema = z.object({
  weeks: z.coerce.number().int().min(1).max(52).default(12),
  bucket: z.enum(['week', 'day']).default('week'),
});

adminAggregateRoutes.get(
  '/adoption',
  zValidator('query', adoptionQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { weeks, bucket } = c.req.valid('query');
    const now = new Date();
    const unit: BucketUnit = bucket;
    const bucketCount = bucket === 'week' ? weeks : weeks * 7;
    const buckets = bucketBoundaries(unit, bucketCount, now);
    const firstBucketStart = buckets[0] as string;

    const [newUsersRows, activeWorkspaceRows, [{ n: baselineUsers } = { n: 0 }]] =
      await Promise.all([
        db.execute(sql`
        SELECT date_trunc(${unit}, created_at) AS bucket, count(*)::int AS n
        FROM users
        WHERE created_at >= ${firstBucketStart}::timestamptz
        GROUP BY 1
      `) as unknown as Promise<Array<{ bucket: unknown; n: number }>>,
        db.execute(sql`
        SELECT date_trunc(${unit}, started_at) AS bucket, count(distinct project_id)::int AS n
        FROM pipeline_runs
        WHERE started_at >= ${firstBucketStart}::timestamptz
        GROUP BY 1
      `) as unknown as Promise<Array<{ bucket: unknown; n: number }>>,
        db
          .select({ n: count() })
          .from(users)
          .where(sql`${users.createdAt} < ${firstBucketStart}::timestamptz`),
      ]);

    const newUsersByBucket = toBucketMap(newUsersRows, 'n');
    const activeWorkspacesByBucket = toBucketMap(activeWorkspaceRows, 'n');

    let cumulative = Number(baselineUsers);
    const rows: AdminAdoptionBucket[] = buckets.map((bucketStart) => {
      const newUsers = newUsersByBucket.get(bucketStart) ?? 0;
      cumulative += newUsers;
      return {
        bucketStart,
        newUsers,
        cumulativeUsers: cumulative,
        activeWorkspaces: activeWorkspacesByBucket.get(bucketStart) ?? 0,
      };
    });

    return c.json(rows);
  },
);

const workspacesQuerySchema = z.object({
  window: z.enum(windows).default('7d'),
  sort: z.enum(['runs', 'spend', 'leadTime']).default('runs'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

adminAggregateRoutes.get(
  '/workspaces',
  zValidator('query', workspacesQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { window, sort, limit } = c.req.valid('query');
    const spec = WINDOW_SPECS[window];
    const cutoff = cutoffExpr(spec.hours);

    const [allProjects, runRows, spendRows, leadTimeRows, openIssueRows] = await Promise.all([
      db
        .select({ id: projects.id, slug: projects.slug })
        .from(projects)
        .where(isNull(projects.archivedAt)),
      db.execute(sql`
        SELECT project_id, count(*)::int AS n
        FROM pipeline_runs
        WHERE started_at >= ${cutoff}
        GROUP BY 1
      `) as unknown as Promise<Array<{ project_id: string; n: number }>>,
      db.execute(sql`
        SELECT project_id, coalesce(sum(estimated_cost), 0)::float AS n
        FROM usage_records
        WHERE recorded_at >= ${cutoff} AND project_id IS NOT NULL
        GROUP BY 1
      `) as unknown as Promise<Array<{ project_id: string; n: number }>>,
      db.execute(sql`
        SELECT i.project_id AS project_id,
               percentile_disc(0.5) WITHIN GROUP (
                 ORDER BY extract(epoch from (al.created_at - i.created_at)) / 60.0
               )::float AS n
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
          AND al.created_at >= ${cutoff}
        GROUP BY 1
      `) as unknown as Promise<Array<{ project_id: string; n: number | null }>>,
      db
        .select({ projectId: issues.projectId, n: count() })
        .from(issues)
        .where(
          sql`${issues.status} NOT IN (${sql.join(
            [...NON_OPEN_STATUSES].map((s) => sql`${s}`),
            sql`, `,
          )})`,
        )
        .groupBy(issues.projectId),
    ]);

    const runsByProject = new Map(runRows.map((r) => [r.project_id, Number(r.n)]));
    const spendByProject = new Map(spendRows.map((r) => [r.project_id, Number(r.n)]));
    const leadTimeByProject = new Map(
      leadTimeRows.map((r) => [r.project_id, r.n == null ? null : Number(r.n)]),
    );
    const openIssuesByProject = new Map(openIssueRows.map((r) => [r.projectId, Number(r.n)]));

    const rows: AdminWorkspaceRow[] = allProjects.map((p) => ({
      projectId: p.id,
      slug: p.slug,
      runs: runsByProject.get(p.id) ?? 0,
      spendUsd: spendByProject.get(p.id) ?? 0,
      medianLeadTimeMin: leadTimeByProject.get(p.id) ?? null,
      openIssues: openIssuesByProject.get(p.id) ?? 0,
    }));

    const sortKey: Record<typeof sort, (r: AdminWorkspaceRow) => number> = {
      runs: (r) => r.runs,
      spend: (r) => r.spendUsd,
      leadTime: (r) => r.medianLeadTimeMin ?? -1,
    };
    rows.sort((a, b) => sortKey[sort](b) - sortKey[sort](a));

    setTotalCount(c, allProjects.length);
    return c.json(rows.slice(0, limit));
  },
);
