/**
 * ISS-103 — read-side REST surface for pipeline_runs.
 *
 * Two GET handlers exposed to the web UI so the issue detail panel and
 * project pipeline runs page can render step timelines + cost rollups
 * without going through the MCP-only `forge_pipeline_runs.*` tools.
 *
 * - `GET /api/pipeline-runs/:id` — full summary (steps + cost).
 * - `GET /api/projects/:id/pipeline-runs` — list with status/issueId
 *   filters, paginated via `X-Total-Count` header (matches the existing
 *   `/projects/:id/jobs` convention).
 *
 * POST handlers (pause/resume/cancel) live in `runs-routes.ts` from ISS-102
 * and are unaffected.
 */

import { zValidator } from '@hono/zod-validator';
import { type SQL, and, count, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { pipelineRunStatuses, pipelineRuns } from '../db/schema.js';
import { paginationSchema, setTotalCount } from '../lib/pagination.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { listItemsFromRows, loadPipelineRunSummary } from './runs-rollup.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const idParamSchema = z.object({ id: z.uuid() });

const listFiltersSchema = paginationSchema.extend({
  status: z.enum(pipelineRunStatuses).optional(),
  issueId: z.uuid().optional(),
});

/** Mounted at `/api/pipeline-runs` (sibling of POST handlers in ISS-102). */
export const pipelineRunReadRoutes = new Hono<{ Variables: AuthVars }>();
pipelineRunReadRoutes.use('*', requireAuth(), assertEmailVerified());

pipelineRunReadRoutes.get(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db
      .select({ projectId: pipelineRuns.projectId })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, id))
      .limit(1);
    if (!row) throw notFound('pipeline run not found');

    const access = await loadProjectAccess(row.projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const summary = await loadPipelineRunSummary(id);
    if (!summary) throw notFound('pipeline run not found');
    return c.json(summary);
  },
);

/** Mounted at `/api/projects` so the route is `/api/projects/:id/pipeline-runs`. */
export const pipelineRunProjectRoutes = new Hono<{ Variables: AuthVars }>();
pipelineRunProjectRoutes.use('*', requireAuth(), assertEmailVerified());

pipelineRunProjectRoutes.get(
  '/:id/pipeline-runs',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', listFiltersSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const q = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const conds: SQL[] = [eq(pipelineRuns.projectId, projectId)];
    if (q.status) conds.push(eq(pipelineRuns.status, q.status));
    if (q.issueId) conds.push(eq(pipelineRuns.issueId, q.issueId));
    const where = conds.length === 1 ? conds[0] : and(...conds);

    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(pipelineRuns)
      .where(where);

    const rows = await db
      .select()
      .from(pipelineRuns)
      .where(where)
      .orderBy(desc(pipelineRuns.startedAt))
      .limit(q.limit)
      .offset(q.offset);

    const items = await listItemsFromRows(rows);
    setTotalCount(c, Number(n));
    return c.json(items);
  },
);
