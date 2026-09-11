/**
 * Admin cross-tenant aggregate endpoints for the Operator Ops Console (Step 1,
 * ISS-651): GET /overview, /adoption, /workspaces. Own requireAdmin gate (like
 * `pipeline-health-routes.ts`) so this router can be imported standalone in a
 * vitest suite.
 *
 * The glance's metric machinery — the window vocabulary, the bucket boundaries,
 * the bucketed readers and the fold — lives in `metric-series.ts` since
 * ISS-975, shared with `GET /metrics/:metric/timeseries`.
 */

import { zValidator } from '@hono/zod-validator';
import { count, eq, inArray, isNull, sql } from 'drizzle-orm';
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
import { listResponse } from '../lib/pagination.js';
import { utcDateTrunc } from '../lib/time-buckets.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { computeAlerts } from './alert-queries.js';
import {
  type BucketUnit,
  bucketBoundaries,
  computeSeries,
  createRawLoaders,
  cutoffExpr,
  METRIC_SOURCES,
  toBucketMap,
  toGlance,
  WINDOW_SPECS,
} from './metric-series.js';
import { readThresholds } from './thresholds.js';
import {
  type AdminAdoptionBucket,
  type AdminGlanceMetric,
  type AdminGlanceMetricName,
  type AdminOverview,
  type AdminWorkspaceRow,
  GLANCE_METRIC_NAMES,
  GLANCE_WINDOWS,
} from './types.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

// cm:edge naming -> packages/core/src/projects/health-routes.ts — mirrors NON_OPEN_STATUSES there; keep the excluded-status set aligned
const NON_OPEN_STATUSES = new Set(['awaiting_release', 'closed', 'draft']);

const overviewQuerySchema = z.object({ window: z.enum(GLANCE_WINDOWS).default('24h') });

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
    // cm:edge contract -> packages/core/src/admin/alert-queries.ts — `openAlerts` is the count of non-`ok` alerts from the SHARED `computeAlerts`, never a second definition: the tile used to approximate A2 alone (running jobs past a hardcoded 600s) and printed "0 · nothing needs you" above a red A1/A3/A4/A5 row, the state-lies failure VISION №10 forbids.
    const thresholds = await readThresholds();
    const openAlerts = (await computeAlerts({ now, thresholds })).filter(
      (a) => a.status !== 'ok',
    ).length;
    const cutoff = cutoffExpr(spec.hours);
    const baseStart = cutoffExpr(spec.hours * 2);
    const raw = createRawLoaders(spec, baseStart, thresholds.interventionLabels);

    const [
      [{ n: usersTotal } = { n: 0 }],
      [{ n: orgsTotal } = { n: 0 }],
      [{ n: projectsTotal } = { n: 0 }],
      [{ n: activeWorkspaces } = { n: 0 }],
      [{ n: devicesOnline } = { n: 0 }],
      [{ n: devicesTotal } = { n: 0 }],
      [{ n: inFlightJobs } = { n: 0 }],
      [{ v: spendWindowUsd } = { v: 0 }],
      [{ v: spendBaselineUsd } = { v: 0 }],
      glanceEntries,
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
      // cm:guard mapped over GLANCE_METRIC_NAMES rather than written out per metric — the five names appear ONCE, in `types.ts`, so the glance and the series route cannot come to measure different things (ISS-975). Spelling a name here again is what the shared union removed.
      Promise.all(
        GLANCE_METRIC_NAMES.map(
          async (name) =>
            [name, toGlance(computeSeries(await METRIC_SOURCES[name](raw), spec, now))] as const,
        ),
      ),
    ]);

    const glance = Object.fromEntries(glanceEntries) as Record<
      AdminGlanceMetricName,
      AdminGlanceMetric
    >;

    const overview: AdminOverview = {
      counts: {
        users: Number(usersTotal),
        usersNew: glance.signupsWindow.value ?? 0,
        orgs: Number(orgsTotal),
        projects: Number(projectsTotal),
        activeWorkspaces: Number(activeWorkspaces),
        devicesOnline: Number(devicesOnline),
        devicesTotal: Number(devicesTotal),
      },
      kpis: {
        openAlerts,
        inFlightJobs: Number(inFlightJobs),
        spendWindowUsd: Number(spendWindowUsd),
        spendBaselineUsd: Number(spendBaselineUsd),
      },
      glance,
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
        SELECT ${utcDateTrunc(unit, sql`created_at`)} AS bucket, count(*)::int AS n
        FROM users
        WHERE created_at >= ${firstBucketStart}::timestamptz
        GROUP BY 1
      `) as unknown as Promise<Array<{ bucket: unknown; n: number }>>,
        db.execute(sql`
        SELECT ${utcDateTrunc(unit, sql`started_at`)} AS bucket, count(distinct project_id)::int AS n
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
  window: z.enum(GLANCE_WINDOWS).default('7d'),
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

    return c.json(listResponse(c, rows.slice(0, limit), allProjects.length, { limit, offset: 0 }));
  },
);
