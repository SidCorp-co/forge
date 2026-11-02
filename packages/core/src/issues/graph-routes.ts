// `GET /api/projects/:id/pm/graph`, the issue graph the forge CLI's `forge_project_pm` reads.

import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { PM_GRAPH_DEFAULT_DEPTH, PM_GRAPH_MAX_DEPTH, readPmGraph } from './graph-read.js';

const graphQuerySchema = z.object({
  rootIssueId: z.uuid().optional(),
  depth: z.coerce.number().int().min(1).max(PM_GRAPH_MAX_DEPTH).default(PM_GRAPH_DEFAULT_DEPTH),
});

export const issueGraphRoutes = new Hono<{ Variables: AuthVars }>();
issueGraphRoutes.use('/:id/pm/graph', requireAuth(), assertEmailVerified());

issueGraphRoutes.get(
  '/:id/pm/graph',
  zValidator('param', idParamSchema),
  requiresOnParam('project.read', 'id'),
  zValidator('query', graphQuerySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { rootIssueId, depth } = c.req.valid('query');
    return c.json(await readPmGraph({ projectId: id, rootIssueId, depth }));
  },
);
