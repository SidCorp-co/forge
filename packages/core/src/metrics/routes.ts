import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
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
  // days window, capped at 90 to bound activity_log / jobs scans (AC #4).
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

    // Same member visibility as /api/projects/health.
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

// cm:guard the PROJECT-scoped half of step durations, and it exists because the cross-project one cannot serve a token: `GET /api/pipeline/step-durations` fans out over every project the caller can see when `projectId` is omitted, so `/api/pipeline` must stay off PAT_ALLOWED_PREFIXES exactly as `/api/me/ops-health` does. Deleting `forge_metrics.step_durations` (ISS-894 wave 3) left a PAT caller with no path at all until this landed — measured live on forge-beta 2026-09-01, the fan-out answered 403 and no project-scoped route existed.
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

// cm:guard the PROJECT-scoped half of each metric lives HERE and the cross-project fan-out lives under `/api/pipeline`, which is off PAT_ALLOWED_PREFIXES and must stay off — it reads across every project the caller can see. This is the pattern, not three coincidences: `step-durations`, `retry-rescues` and `session-failures` all had a fan-out route and no project-scoped one, so retiring their tools would have left a token-holding caller with nothing. Any new metric needs BOTH halves or neither.
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
