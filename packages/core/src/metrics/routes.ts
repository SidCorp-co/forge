import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { buildInterventionsReport } from './interventions-report.js';
import { BUCKETS, METRICS, runTimeseries, stepDurationsForProject } from './queries.js';
import { buildRetryRescuesReport, buildSessionFailuresReport } from './session-failures-report.js';

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

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

projectMetricsRoutes.get(
  '/:id/metrics/timeseries',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('query', timeseriesQuerySchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    if (!access.role) throw forbidden('not a project member');

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

const stepDurationsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  step: z.string().trim().min(1).max(64).optional(),
  breakdown: z.enum(['device', 'model']).optional(),
});

projectMetricsRoutes.get(
  '/:id/metrics/step-durations',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('query', stepDurationsQuerySchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const access = await loadProjectAccess(id, c.get('userId'));
    if (!access.role) throw forbidden('not a project member');

    const { days, step, breakdown } = c.req.valid('query');
    return c.json({
      rows: await stepDurationsForProject(id, days, step, breakdown),
      windowDays: days,
    });
  },
);

const daysQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

projectMetricsRoutes.get(
  '/:id/metrics/retry-rescues',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', daysQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const access = await loadProjectAccess(id, c.get('userId'));
    if (!access.role) throw forbidden('not a project member');

    const { days } = c.req.valid('query');
    return c.json(await buildRetryRescuesReport(id, days));
  },
);

projectMetricsRoutes.get(
  '/:id/metrics/session-failures',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', daysQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const access = await loadProjectAccess(id, c.get('userId'));
    if (!access.role) throw forbidden('not a project member');

    const { days } = c.req.valid('query');
    return c.json(await buildSessionFailuresReport(id, days));
  },
);

projectMetricsRoutes.get(
  '/:id/metrics/interventions',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', daysQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const access = await loadProjectAccess(id, c.get('userId'));
    if (!access.role) throw forbidden('not a project member');

    const { days } = c.req.valid('query');
    return c.json(await buildInterventionsReport([id], days));
  },
);
