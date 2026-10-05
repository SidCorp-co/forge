import {
  RUN_STANDING_LIST_DEFAULT,
  RUN_STANDING_LIST_MAX,
  RUN_STANDING_SCOPES,
} from '@forge/contracts/run-standing';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { notFound } from '../middleware/route-errors.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { listRunStanding, readRunStanding } from './read.js';

const projectParam = z.object({ id: z.uuid() });
const runParam = z.object({ id: z.uuid(), runId: z.uuid() });
const listQuery = z.strictObject({
  scope: z.enum(RUN_STANDING_SCOPES).default('live'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(RUN_STANDING_LIST_MAX)
    .default(RUN_STANDING_LIST_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});
const noQuery = z.strictObject({});

export { projectSnapshotRoutes } from './snapshot-routes.js';

export const runStandingRoutes = new Hono<{ Variables: AuthVars }>();
runStandingRoutes.use('/:id/runs/standing', requireAuth(), assertEmailVerified());
runStandingRoutes.use('/:id/runs/standing/*', requireAuth(), assertEmailVerified());

async function member(projectId: string, userId: string | undefined) {
  const access = await loadProjectAccess(projectId, userId);
  requireHeld(access, 'project.read');
}

runStandingRoutes.get(
  '/:id/runs/standing',
  zValidator(
    'param',
    projectParam,
    invalid('invalid path: /api/projects/<project uuid>/runs/standing'),
  ),
  zValidator('query', listQuery),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    await member(projectId, userId);
    const listed = await listRunStanding(
      projectId,
      c.req.valid('query'),
      userId ? { userId } : null,
    );
    return c.json(
      await egressForRequest(restActor(c).agency, projectId, 'issue', listed, 'the run list'),
    );
  },
);

runStandingRoutes.get(
  '/:id/runs/standing/:runId',
  zValidator(
    'param',
    runParam,
    invalid('invalid path: /api/projects/<project uuid>/runs/standing/<pipeline run uuid>'),
  ),
  zValidator('query', noQuery),
  async (c) => {
    const { id: projectId, runId } = c.req.valid('param');
    const userId = c.get('userId');
    await member(projectId, userId);
    const detail = await readRunStanding(projectId, runId, userId ? { userId } : null);
    if (!detail) {
      throw notFound(
        `run ${runId} is not a run of this project: no pipeline run with that id, or it is a chat or a master's own run, which this list does not serve`,
      );
    }
    return c.json(
      await egressForRequest(restActor(c).agency, projectId, 'issue', detail, `run ${runId}`),
    );
  },
);
