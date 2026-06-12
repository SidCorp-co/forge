import { zValidator } from '@hono/zod-validator';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { activityLog, issues, jobTypes, projectMembers, projects } from '../db/schema.js';
import { effectiveProjectRole, loadVisibleProjectIds } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

// Project-member gate for the per-project cost analytics endpoints. 404 when
// the project does not exist so we don't leak existence to non-members.
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
 * Daily closure rate per project. Used for the throughput trend line chart
 * on /pipeline/health. Counts `activity_log` entries where `payload.to` is
 * `closed` or `released` over the requested window.
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

    // Bucket by UTC day. The `now() - interval` cutoff is computed in SQL
    // because postgres-js refuses to bind JS Date through parameters
    // (see ISS-267).
    const rows = await db
      .select({
        projectId: issues.projectId,
        date: sql<string>`date_trunc('day', ${activityLog.createdAt})::date::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(activityLog)
      .innerJoin(issues, eq(issues.id, activityLog.issueId))
      .where(
        sql`${activityLog.action} = 'issue.statusChanged'
          AND ${activityLog.payload} ->> 'to' IN ('closed','released')
          AND ${activityLog.createdAt} >= now() - (${days}::int * interval '1 day')
          AND ${issues.projectId} IN ${projectIds}`,
      )
      .groupBy(issues.projectId, sql`date_trunc('day', ${activityLog.createdAt})`)
      .orderBy(sql`date_trunc('day', ${activityLog.createdAt})`);

    return c.json(
      rows.map((r) => ({
        projectId: r.projectId,
        date: r.date,
        count: Number(r.count),
      })),
    );
  },
);

/**
 * Average time issues spent in each pipeline stage before transitioning out.
 * Computed via LAG over the per-issue activity stream — `prev_to` is the
 * status the issue was IN before the current transition fired, and the
 * delta to that prior event is the time-in-status.
 */
pipelineAnalyticsRoutes.get(
  '/cycle-time',
  zValidator('query', cycleTimeQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const userId = c.get('userId');

    const projectIds = await loadVisibleProjectIdsScoped(userId, projectId);
    if (projectIds.length === 0) return c.json([]);

    const rows = await db.execute(sql`
      WITH transitions AS (
        SELECT
          ${activityLog.issueId} AS issue_id,
          ${issues.projectId} AS project_id,
          ${activityLog.payload} ->> 'to' AS to_status,
          ${activityLog.createdAt} AS created_at,
          LAG(${activityLog.createdAt}) OVER (
            PARTITION BY ${activityLog.issueId}
            ORDER BY ${activityLog.createdAt}
          ) AS prev_created_at,
          LAG(${activityLog.payload} ->> 'to') OVER (
            PARTITION BY ${activityLog.issueId}
            ORDER BY ${activityLog.createdAt}
          ) AS prev_to
        FROM ${activityLog}
        INNER JOIN ${issues} ON ${issues.id} = ${activityLog.issueId}
        WHERE ${activityLog.action} = 'issue.statusChanged'
          AND ${issues.projectId} IN ${projectIds}
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

/**
 * ISS-104 — per-step pipeline durations. Sourced from the
 * `pipeline_run_step_durations` view (migration 0055), one row per
 * completed job under a pipeline_run. `issueId` is null for runs of kind
 * `pm`/`interactive`/`system`. Capped at 1000 rows so a careless caller
 * can't dump the whole window into a single response.
 */
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
             duration_seconds, cost_usd
      FROM pipeline_run_step_durations
      WHERE project_id IN ${projectIds}
        AND started_at >= now() - (${days}::int * interval '1 day')
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
    }));
    return c.json(out);
  },
);

/**
 * ISS-452 (ISS-442 C6 / I7 amendment 1) — queryable interventions metric.
 * Reads the `issue_intervention_events` view (migration 0117): one row per
 * intervention-class event — `wedge` (pipeline_wedge notifications),
 * `manual_cancel` (C0's audited job_events.kind='intervention'),
 * `user_run_flip` (C1 kernel_transitions, entity='run', actor_type='user').
 * Returns the per-issue rollup plus the raw events so VISION §1 metric ②
 * (interventions per issue closed) is chartable. `issueId: null` groups the
 * project-scoped events (pm/system runs).
 */
pipelineAnalyticsRoutes.get(
  '/interventions',
  zValidator('query', querySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { days, projectId } = c.req.valid('query');
    const userId = c.get('userId');

    const projectIds = await loadVisibleProjectIdsScoped(userId, projectId);
    if (projectIds.length === 0) return c.json({ total: 0, byIssue: [], events: [] });

    const rows = await db.execute(sql`
      SELECT source, project_id, issue_id, occurred_at, detail
      FROM issue_intervention_events
      WHERE project_id IN ${projectIds}
        AND occurred_at >= now() - (${days}::int * interval '1 day')
      ORDER BY occurred_at DESC
      LIMIT 2000
    `);

    type Row = {
      source: 'wedge' | 'manual_cancel' | 'user_run_flip';
      project_id: string;
      issue_id: string | null;
      occurred_at: string;
      detail: string | null;
    };
    const events = (rows as unknown as Row[]).map((r) => ({
      source: r.source,
      projectId: r.project_id,
      issueId: r.issue_id,
      occurredAt: r.occurred_at,
      detail: r.detail,
    }));

    const byIssueMap = new Map<
      string,
      {
        issueId: string | null;
        projectId: string;
        wedges: number;
        manualCancels: number;
        userRunFlips: number;
        total: number;
        lastAt: string;
      }
    >();
    for (const e of events) {
      const key = `${e.projectId}:${e.issueId ?? ''}`;
      const agg = byIssueMap.get(key) ?? {
        issueId: e.issueId,
        projectId: e.projectId,
        wedges: 0,
        manualCancels: 0,
        userRunFlips: 0,
        total: 0,
        lastAt: e.occurredAt,
      };
      if (e.source === 'wedge') agg.wedges++;
      else if (e.source === 'manual_cancel') agg.manualCancels++;
      else agg.userRunFlips++;
      agg.total++;
      if (e.occurredAt > agg.lastAt) agg.lastAt = e.occurredAt;
      byIssueMap.set(key, agg);
    }
    const byIssue = [...byIssueMap.values()].sort((a, b) => b.total - a.total);

    return c.json({ total: events.length, byIssue, events });
  },
);

/**
 * W2.2.1 — per-project cost analytics. Mounted under `/api/projects/:id` so
 * the URL reads as a project-scoped sub-resource. Project-member-only; CEO
 * bypass mirrors `loadVisibleProjectIds`. Data sourced from the
 * `pipeline_run_step_durations` view (migration 0055 / extended in 0075).
 */
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
      SELECT date_trunc('day', started_at)::date::text AS date,
             SUM(cost_usd)::float AS cost,
             COUNT(*)::int AS runs
      FROM pipeline_run_step_durations
      WHERE project_id = ${id}
        AND started_at >= now() - (${days}::int * interval '1 day')
        ${stepFilter}
      GROUP BY date_trunc('day', started_at)
      ORDER BY date_trunc('day', started_at) ASC
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
