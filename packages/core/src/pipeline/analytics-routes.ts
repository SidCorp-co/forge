import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  activityLog,
  issues,
  jobTypes,
  projectMembers,
  projects,
  users,
} from '../db/schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

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

async function loadVisibleProjectIds(userId: string, scopedTo?: string): Promise<string[]> {
  const [me] = await db
    .select({ id: users.id, isCeo: users.isCeo })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const visible = me?.isCeo
    ? await db.select({ id: projects.id }).from(projects)
    : await db
        .selectDistinct({ id: projects.id })
        .from(projects)
        .leftJoin(projectMembers, eq(projectMembers.projectId, projects.id))
        .where(
          sql`${projects.ownerId} = ${userId} OR ${projectMembers.userId} = ${userId}`,
        );

  const ids = visible.map((r) => r.id);
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

    const projectIds = await loadVisibleProjectIds(userId, projectId);
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

    const projectIds = await loadVisibleProjectIds(userId, projectId);
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

    const projectIds = await loadVisibleProjectIds(userId, projectId);
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
