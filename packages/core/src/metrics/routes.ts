import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { BUCKETS, METRICS, runTimeseries } from './timeseries.js';

/**
 * Project-scoped time-series metrics for the v2 dashboard trend charts
 * (ISS-380, Part 1). Same auth class as `/api/projects/health`
 * (requireAuth + assertEmailVerified) plus a per-project membership guard.
 * All series are derived from existing tables — no new collection.
 */
export const projectMetricsRoutes = new Hono<{ Variables: AuthVars }>();

projectMetricsRoutes.use('/:id/metrics/*', requireAuth(), assertEmailVerified());

const idParamSchema = z.object({ id: z.uuid() });

const timeseriesQuerySchema = z.object({
  metric: z.enum(METRICS),
  days: z.coerce.number().int().min(1).max(90).default(30),
  bucket: z.enum(BUCKETS).default('day'),
  groupBy: z.literal('step').optional(),
});

projectMetricsRoutes.get(
  '/:id/metrics/timeseries',
  zValidator('param', idParamSchema),
  zValidator('query', timeseriesQuerySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    requireHeld(access, 'project.read');

    const { metric, days, bucket, groupBy } = c.req.valid('query');
    const result = await runTimeseries({
      projectId: id,
      metric,
      days,
      bucket,
      groupByStep: groupBy === 'step',
    });
    return c.json(result);
  },
);
