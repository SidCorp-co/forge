import { doorUseQuerySchema } from '@forge/contracts/door-use';
import { HEALTH_WINDOWS } from '@forge/contracts/project-health';
import { Hono } from 'hono';
import { z } from 'zod';
import { doorCatalog } from '../lib/door-catalog.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { readDoorUse } from './door-use.js';
import { projectHealth } from './health.js';
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
  requiresOnParam('project.read', 'id'),
  zValidator('query', timeseriesQuerySchema),
  async (c) => {
    const { id } = c.req.valid('param');
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

const healthQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((d) => (HEALTH_WINDOWS as readonly number[]).includes(d), {
      message: `days is one of ${HEALTH_WINDOWS.join(', ')}`,
    })
    .default(30),
});

/** The project dashboard's health panel (REQ-24): four figures per day over the chosen window. */
projectMetricsRoutes.get(
  '/:id/metrics/health',
  zValidator('param', idParamSchema),
  requiresOnParam('project.read', 'id'),
  zValidator('query', healthQuerySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await projectHealth(id, c.req.valid('query').days));
  },
);

/**
 * Which doors this project's agents used over the window and which they never reached for, by agent
 * kind, with what they read and the lessons they applied (ISS-1251): the catalog is the denominator,
 * so a door no agent called shows with 0.
 */
projectMetricsRoutes.get(
  '/:id/metrics/doors',
  zValidator('param', idParamSchema),
  requiresOnParam('project.read', 'id'),
  zValidator('query', doorUseQuerySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await readDoorUse(id, c.req.valid('query'), doorCatalog()));
  },
);
