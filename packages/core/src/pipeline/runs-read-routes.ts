import { Hono } from 'hono';
import { z } from 'zod';
import { pipelineRunStatuses } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { listResponse, paginationSchema } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest, idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { listProjectPipelineRuns, pipelineRunProjectId } from './read.js';
import { loadPipelineRunSummary } from './runs-rollup.js';
import { requireHeld } from '../permissions/index.js';

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
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const projectId = await pipelineRunProjectId(id);
    if (!projectId) throw notFound('pipeline run not found');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

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
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', listFiltersSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const q = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const { items, total } = await listProjectPipelineRuns(projectId, q);
    return c.json(listResponse(c, items, total, q));
  },
);
