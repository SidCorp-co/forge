import { zValidator } from '@hono/zod-validator';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { activityLog, issues, jobTypes } from '../db/schema.js';
import { effectiveProjectRole, loadVisibleProjectIds } from '../lib/authz.js';
import { utcDayText } from '../lib/time-buckets.js';
import { buildInterventionsReport } from '../metrics/interventions-report.js';
import { retryRescuesSince } from '../metrics/queries.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { cycleTimeTransitionsSql } from './cycle-time-sql.js';
import { driverComparison } from './driver-comparison.js';
import { shippedPerDay } from './throughput-series.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

async function assertProjectMember(projectId: string, userId: string): Promise<void> {
  const access = await effectiveProjectRole(userId, projectId);
  if (!access) throw notFound('project not found');
  if (!access.role) throw forbidden('not a project member');
}

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(30),
  projectId: z.uuid().optional(),
});

const cycleTimeQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(30),
  projectId: z.uuid().optional(),
});

const stepDurationsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(30),
  projectId: z.uuid().optional(),
  step: z.enum(jobTypes).optional(),
});

async function loadVisibleProjectIdsScoped(userId: string, scopedTo?: string): Promise<string[]> {
  const ids = await loadVisibleProjectIds(userId);
  if (!scopedTo) return ids;
  return ids.includes(scopedTo) ? [scopedTo] : [];
}

export const pipelineAnalyticsRoutes = new Hono<{ Variables: AuthVars }>();
pipelineAnalyticsRoutes.use('*', requireAuth(), assertEmailVerified());

/**
 * Issues shipped per project per UTC day, one row for each of the last `days` calendar dates
 * whether or not anything shipped on it — see `shippedPerDay`.
 */
pipelineAnalyticsRoutes.get(
  '/throughput',
  zValidator('query', querySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { days, projectId } = c.req.valid('query');
    const userId = c.get('userId');

    const projectIds = await loadVisibleProjectIdsScoped(userId, projectId);
    if (projectIds.length === 0) return c.json([]);

    return c.json(await shippedPerDay(projectIds, days, new Date()));
  },
);

/**
 * Average time issues spent in each pipeline stage before transitioning out.
 * Computed via LAG over the per-issue activity stream — `prev_to` is the
 * status the issue was IN before the current transition fired, and the
 * delta to that prior event is the time-in-status.
 *
 * The `days` window is the row set the LAG runs over, so the oldest transition
 * inside it has no predecessor and contributes nothing: the figure is
 * time-in-status for the pairs that BOTH fall in the window, not for every pair
 * whose second half does. That is what a caller widening `days` is buying.
 */
pipelineAnalyticsRoutes.get(
  '/cycle-time',
  zValidator('query', cycleTimeQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { days, projectId } = c.req.valid('query');
    const userId = c.get('userId');

    const projectIds = await loadVisibleProjectIdsScoped(userId, projectId);
    if (projectIds.length === 0) return c.json([]);

    const rows = await db.execute(sql`
      WITH transitions AS (${cycleTimeTransitionsSql(projectIds, days)}
      )
      SELECT
        prev_to AS status,
        AVG(EXTRACT(EPOCH FROM (created_at - prev_created_at)) / 3600.0)::float AS avg_hours,
        count(*)::int AS n
      FROM transitions
      WHERE prev_created_at IS NOT NULL AND prev_to IS NOT NULL
      GROUP BY prev_to
      ORDER BY n DESC
    `);

    const out = (rows as unknown as Array<{ status: string; avg_hours: number; n: number }>).map(
      (r) => ({
        status: r.status,
        avgHours: Number(r.avg_hours),
        n: Number(r.n),
      }),
    );
    return c.json(out);
  },
);

pipelineAnalyticsRoutes.get(
  '/step-durations',
  zValidator('query', stepDurationsQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { days, projectId, step } = c.req.valid('query');
    const userId = c.get('userId');

    const projectIds = await loadVisibleProjectIdsScoped(userId, projectId);
    if (projectIds.length === 0) return c.json([]);

    const stepFilter = step ? sql`AND step = ${step}` : sql``;
    const rows = await db.execute(sql`
      SELECT run_id, issue_id, project_id, step, started_at, finished_at,
             duration_seconds, cost_usd, device_id, model_used
      FROM pipeline_run_step_durations
      WHERE project_id IN ${projectIds}
        AND started_at >= now() - (${days}::int * interval '1 day')
        AND duration_seconds IS NOT NULL
        ${stepFilter}
      ORDER BY started_at DESC
      LIMIT 1000
    `);

    const out = (
      rows as unknown as Array<{
        run_id: string;
        issue_id: string | null;
        project_id: string;
        step: string;
        started_at: string;
        finished_at: string;
        duration_seconds: number;
        cost_usd: number;
        device_id: string | null;
        model_used: string | null;
      }>
    ).map((r) => ({
      runId: r.run_id,
      issueId: r.issue_id,
      projectId: r.project_id,
      step: r.step,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationSeconds: Number(r.duration_seconds),
      costUsd: Number(r.cost_usd),
      deviceId: r.device_id,
      modelUsed: r.model_used,
    }));
    return c.json(out);
  },
);

/**
 * ISS-826 — retry failures that a later attempt rescued. Grouping by the
 * original failure reason makes repeated eventually-green failures observable
 * as one operational signal.
 *
 * ISS-1022 — read through `retry_rescues_since`, not the `retry_rescues` view:
 * the view's recursion walks every `retry_of` chain in `jobs` before a caller's
 * project and window filter can apply, so the bound has to reach the anchor.
 */
pipelineAnalyticsRoutes.get(
  '/retry-rescues',
  zValidator('query', querySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { days, projectId } = c.req.valid('query');
    const userId = c.get('userId');
    const projectIds = await loadVisibleProjectIdsScoped(userId, projectId);
    if (projectIds.length === 0) return c.json({ total: 0, reasons: [] });

    const rows = await db.execute(sql`
      SELECT project_id, failure_kind, failure_reason, count(*)::int AS rescues,
             max(rescued_at) AS last_rescued_at
      FROM ${retryRescuesSince(projectIds, sql`now() - (${days}::int * interval '1 day')`)}
      GROUP BY project_id, failure_kind, failure_reason
      ORDER BY rescues DESC, last_rescued_at DESC
      LIMIT 2000
    `);
    const reasons = (
      rows as unknown as Array<{
        project_id: string;
        failure_kind: string | null;
        failure_reason: string;
        rescues: number | string;
        last_rescued_at: string | Date;
      }>
    ).map((row) => ({
      projectId: row.project_id,
      failureKind: row.failure_kind,
      failureReason: row.failure_reason,
      rescues: Number(row.rescues),
      lastRescuedAt:
        row.last_rescued_at instanceof Date
          ? row.last_rescued_at.toISOString()
          : String(row.last_rescued_at),
    }));

    return c.json({ total: reasons.reduce((total, row) => total + row.rescues, 0), reasons });
  },
);

pipelineAnalyticsRoutes.get(
  '/interventions',
  zValidator('query', querySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { days, projectId } = c.req.valid('query');
    const userId = c.get('userId');

    const projectIds = await loadVisibleProjectIdsScoped(userId, projectId);
    return c.json(await buildInterventionsReport(projectIds, days));
  },
);

export const projectCostAnalyticsRoutes = new Hono<{ Variables: AuthVars }>();
projectCostAnalyticsRoutes.use('*', requireAuth(), assertEmailVerified());

const projectIdParamSchema = z.object({ id: z.uuid() });

const costSummaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(30),
});

const costTrendQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(90),
  step: z.enum(jobTypes).optional(),
});

const outliersQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(30),
});

/**
 * Window cost summary. One row total, grouped-by-step rollup, and the top
 * 10 issues by cost in the window. Three SELECTs over a single CTE so the
 * query planner can prune the window once.
 */
projectCostAnalyticsRoutes.get(
  '/:id/analytics/cost-summary',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', costSummaryQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { days } = c.req.valid('query');
    const userId = c.get('userId');
    await assertProjectMember(id, userId);

    const totalRows = await db.execute(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::float AS total
      FROM pipeline_run_step_durations
      WHERE project_id = ${id}
        AND started_at >= now() - (${days}::int * interval '1 day')
    `);
    const total = Number((totalRows as unknown as Array<{ total: number }>)[0]?.total ?? 0);

    const byStateRows = await db.execute(sql`
      SELECT step, SUM(cost_usd)::float AS total, COUNT(*)::int AS runs
      FROM pipeline_run_step_durations
      WHERE project_id = ${id}
        AND started_at >= now() - (${days}::int * interval '1 day')
      GROUP BY step
      ORDER BY total DESC
    `);

    const byIssueRows = await db.execute(sql`
      SELECT issue_id, SUM(cost_usd)::float AS total
      FROM pipeline_run_step_durations
      WHERE project_id = ${id}
        AND started_at >= now() - (${days}::int * interval '1 day')
        AND issue_id IS NOT NULL
      GROUP BY issue_id
      ORDER BY total DESC
      LIMIT 10
    `);

    const byState = (
      byStateRows as unknown as Array<{ step: string; total: number; runs: number }>
    ).map((r) => {
      const totalCost = Number(r.total);
      const runs = Number(r.runs);
      return {
        state: r.step,
        total: totalCost,
        runs,
        avgPerRun: runs > 0 ? totalCost / runs : 0,
      };
    });

    const byIssue = (byIssueRows as unknown as Array<{ issue_id: string; total: number }>).map(
      (r) => ({ issueId: r.issue_id, total: Number(r.total) }),
    );

    return c.json({ total, byState, byIssue });
  },
);

/**
 * Daily cost trend for the project. Optional `step` filter narrows the
 * series to a single job type. `annotations` surface pipeline-config edits
 * from `activity_log` (action = 'pipeline_config.updated'); the emitter is
 * tracked separately — until it lands, this array stays empty.
 */
projectCostAnalyticsRoutes.get(
  '/:id/analytics/cost-trend',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', costTrendQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { days, step } = c.req.valid('query');
    const userId = c.get('userId');
    await assertProjectMember(id, userId);

    const stepFilter = step ? sql`AND step = ${step}` : sql``;
    const dailyRows = await db.execute(sql`
      SELECT ${utcDayText(sql`started_at`)} AS date,
             SUM(cost_usd)::float AS cost,
             COUNT(*)::int AS runs
      FROM pipeline_run_step_durations
      WHERE project_id = ${id}
        AND started_at >= now() - (${days}::int * interval '1 day')
        ${stepFilter}
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    const annotationRows = await db.execute(sql`
      SELECT ${activityLog.createdAt} AS ts,
             COALESCE(${activityLog.payload} ->> 'message', 'pipeline config updated') AS message
      FROM ${activityLog}
      INNER JOIN ${issues} ON ${issues.id} = ${activityLog.issueId}
      WHERE ${activityLog.action} = 'pipeline_config.updated'
        AND ${issues.projectId} = ${id}
        AND ${activityLog.createdAt} >= now() - (${days}::int * interval '1 day')
      ORDER BY ${activityLog.createdAt} ASC
    `);

    const daily = (dailyRows as unknown as Array<{ date: string; cost: number; runs: number }>).map(
      (r) => ({ date: r.date, cost: Number(r.cost), runs: Number(r.runs) }),
    );

    const annotations = (
      annotationRows as unknown as Array<{ ts: string | Date; message: string }>
    ).map((r) => ({
      ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      message: r.message,
      kind: 'pipeline_config.updated' as const,
    }));

    return c.json({ daily, annotations });
  },
);

/**
 * Outlier runs in the window — those at or above the dynamic p95 of
 * `cost_usd`. Threshold is recomputed per request from the view rows
 * because the value depends on `days`, never hard-coded. Capped at 100 rows.
 */
projectCostAnalyticsRoutes.get(
  '/:id/analytics/outliers',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', outliersQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { days } = c.req.valid('query');
    const userId = c.get('userId');
    await assertProjectMember(id, userId);

    const rows = await db.execute(sql`
      WITH win AS (
        SELECT v.run_id, v.issue_id, v.step, v.cost_usd,
               j.id AS job_id, j.agent_session_id
        FROM pipeline_run_step_durations v
        JOIN jobs j ON j.pipeline_run_id = v.run_id AND j.type = v.step
        WHERE v.project_id = ${id}
          AND v.started_at >= now() - (${days}::int * interval '1 day')
      ),
      thresh AS (
        SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY cost_usd)::float AS p95
        FROM win
      )
      SELECT win.job_id, win.step AS state, win.cost_usd AS cost, win.issue_id,
             COALESCE(length(i.description), 0) AS description_len,
             COALESCE(jsonb_array_length(s.messages), 0) AS session_depth,
             (SELECT p95 FROM thresh) AS threshold
      FROM win
      LEFT JOIN issues i ON i.id = win.issue_id
      LEFT JOIN agent_sessions s ON s.id = win.agent_session_id
      WHERE win.cost_usd >= (SELECT p95 FROM thresh)
        AND (SELECT p95 FROM thresh) > 0
      ORDER BY win.cost_usd DESC
      LIMIT 100
    `);

    const typed = rows as unknown as Array<{
      job_id: string;
      state: string;
      cost: number;
      issue_id: string | null;
      description_len: number;
      session_depth: number;
      threshold: number;
    }>;

    const threshold = typed.length > 0 ? Number(typed[0]?.threshold ?? 0) : 0;
    const runs = typed.map((r) => ({
      jobId: r.job_id,
      state: r.state,
      cost: Number(r.cost),
      issueId: r.issue_id,
      dimensions: {
        descriptionLen: Number(r.description_len),
        sessionDepth: Number(r.session_depth),
      },
    }));

    return c.json({ threshold, runs });
  },
);

pipelineAnalyticsRoutes.get(
  '/driver-comparison',
  zValidator('query', querySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { days, projectId } = c.req.valid('query');
    const projectIds = await loadVisibleProjectIdsScoped(c.get('userId'), projectId);
    return c.json({ days, projects: await driverComparison({ days, projectIds }) });
  },
);
