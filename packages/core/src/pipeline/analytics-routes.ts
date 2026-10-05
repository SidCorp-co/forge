import { Hono } from 'hono';
import { z } from 'zod';
import { jobTypes } from '../db/schema.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { readCostSummary, readStepDurations } from './read.js';
import { shippedPerDay } from './throughput-series.js';

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(30),
  projectId: z.uuid().optional(),
});

const stepDurationsQuerySchema = querySchema.extend({ step: z.enum(jobTypes).optional() });

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
pipelineAnalyticsRoutes.get('/throughput', zValidator('query', querySchema), async (c) => {
  const { days, projectId } = c.req.valid('query');
  const userId = c.get('userId');

  const projectIds = await loadVisibleProjectIdsScoped(userId, projectId);
  if (projectIds.length === 0) return c.json([]);

  return c.json(await shippedPerDay(projectIds, days, new Date()));
});

pipelineAnalyticsRoutes.get(
  '/step-durations',
  zValidator('query', stepDurationsQuerySchema),
  async (c) => {
    const { days, projectId, step } = c.req.valid('query');
    const userId = c.get('userId');

    const projectIds = await loadVisibleProjectIdsScoped(userId, projectId);
    if (projectIds.length === 0) return c.json([]);

    return c.json(await readStepDurations(projectIds, days, step));
  },
);

export const projectCostAnalyticsRoutes = new Hono<{ Variables: AuthVars }>();
projectCostAnalyticsRoutes.use('*', requireAuth(), assertEmailVerified());

const costSummaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(30),
});

/**
 * Window cost summary. One row total, grouped-by-step rollup, and the top
 * 10 issues by cost in the window. Three SELECTs over a single CTE so the
 * query planner can prune the window once.
 */
projectCostAnalyticsRoutes.get(
  '/:id/analytics/cost-summary',
  zValidator('param', idParamSchema),
  zValidator('query', costSummaryQuerySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { days } = c.req.valid('query');
    const userId = c.get('userId');
    await requireCan(actorFor(userId), 'project.read', projectResource(id));

    return c.json(await readCostSummary(id, days));
  },
);
