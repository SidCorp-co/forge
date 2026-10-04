import { Hono } from 'hono';
import { z } from 'zod';
import { jobTypes } from '../db/schema.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { buildInterventionsReport } from '../metrics/interventions-report.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { driverComparison } from './driver-comparison.js';
import {
  readCostOutliers,
  readCostSummary,
  readCostTrend,
  readCycleTime,
  readRetryRescues,
  readStepDurations,
} from './read.js';
import { shippedPerDay } from './throughput-series.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';

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

    return c.json(await readCycleTime(projectIds, days));
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

    return c.json(await readStepDurations(projectIds, days, step));
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

    return c.json(await readRetryRescues(projectIds, days));
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
    await requireCan(actorFor(userId), 'project.read', projectResource(id));

    return c.json(await readCostSummary(id, days));
  },
);

/**
 * Daily cost trend for the project. Optional `step` filter narrows the
 * series to a single job type.
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
    await requireCan(actorFor(userId), 'project.read', projectResource(id));

    return c.json(await readCostTrend(id, days, step));
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
    await requireCan(actorFor(userId), 'project.read', projectResource(id));

    return c.json(await readCostOutliers(id, days));
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
