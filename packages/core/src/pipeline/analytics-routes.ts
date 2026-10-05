import { Hono } from 'hono';
import { z } from 'zod';
import { jobTypes } from '../db/schema.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { readStepDurations } from './read.js';
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
