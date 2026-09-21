/**
 * `GET /api/admin/metrics/:metric/timeseries` — the series behind a console
 * glance figure (ISS-975).
 *
 * The glance answers one value, one arrow and a 24-point spark; this answers
 * the dense series those are folded from, over the same five metric names and
 * the same window vocabulary. Own requireAdmin gate (like its siblings) so the
 * router can be imported standalone in a vitest suite.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';
import {
  computeSeries,
  createRawLoaders,
  cutoffExpr,
  deltaPct,
  METRIC_SOURCES,
  WINDOW_SPECS,
} from './metric-series.js';
import { readThresholds } from './thresholds.js';
import { type AdminMetricSeries, GLANCE_METRIC_NAMES, GLANCE_WINDOWS } from './types.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const paramSchema = z.object({ metric: z.enum(GLANCE_METRIC_NAMES) });

const querySchema = z.object({ window: z.enum(GLANCE_WINDOWS).default('24h') });

export const adminMetricSeriesRoutes = new Hono<{ Variables: AuthVars }>();

adminMetricSeriesRoutes.use('*', requireAuth(), assertEmailVerified(), requireAdmin());

adminMetricSeriesRoutes.get(
  '/metrics/:metric/timeseries',
  zValidator('param', paramSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', querySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { metric } = c.req.valid('param');
    const { window } = c.req.valid('query');
    const spec = WINDOW_SPECS[window];
    const now = new Date();

    const thresholds = await readThresholds();
    const baseStart = cutoffExpr(spec.hours * 2);
    const raw = createRawLoaders(spec, baseStart, thresholds.interventionLabels);
    const series = computeSeries(await METRIC_SOURCES[metric](raw), spec, now);

    const body: AdminMetricSeries = {
      metric,
      window,
      value: series.value,
      deltaPct: deltaPct(series.value, series.baseline),
      points: series.points,
    };
    return c.json(body);
  },
);
