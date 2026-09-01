/**
 * The three PM reads that `forge_project_pm` served and no route did:
 * snapshot, graph and runner load.
 *
 * The write half of that tool already has routes under `pm/routes.ts`
 * (config, policies, decisions, escalations, run). These are the reads.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { PM_GRAPH_DEFAULT_DEPTH, PM_GRAPH_MAX_DEPTH, readPmGraph } from './graph-service.js';
import { readRunnerLoad } from './runner-load-service.js';
import { readPmSnapshot } from './snapshot-service.js';

const paramSchema = z.object({ id: z.uuid() });

const graphQuerySchema = z.object({
  rootIssueId: z.uuid().optional(),
  depth: z.coerce.number().int().min(1).max(PM_GRAPH_MAX_DEPTH).default(PM_GRAPH_DEFAULT_DEPTH),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

// cm:guard mounted UNCONDITIONALLY while `pm/routes.ts` sits behind `isEnabled('pmAgent')`, and the asymmetry is deliberate: `forge_project_pm` is registered regardless of that flag, so a replacement gated by it would answer 404 on any deployment with the flag off — turning a tool deletion into a capability loss that only shows up where nobody is looking. Move these under the flag only in a change that also flag-gates the tool.
export const pmReadRoutes = new Hono<{ Variables: AuthVars }>();
pmReadRoutes.use('/:id/pm/snapshot', requireAuth(), assertEmailVerified());
pmReadRoutes.use('/:id/pm/graph', requireAuth(), assertEmailVerified());
pmReadRoutes.use('/:id/pm/runner-load', requireAuth(), assertEmailVerified());

async function assertMember(projectId: string, userId: string): Promise<void> {
  const access = await loadProjectAccess(projectId, userId);
  assertProjectRole(access, 'viewer', 'not a project member');
}

pmReadRoutes.get(
  '/:id/pm/snapshot',
  zValidator('param', paramSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    await assertMember(id, c.get('userId'));
    return c.json(await readPmSnapshot(id));
  },
);

pmReadRoutes.get(
  '/:id/pm/graph',
  zValidator('param', paramSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', graphQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { rootIssueId, depth } = c.req.valid('query');
    await assertMember(id, c.get('userId'));
    return c.json(await readPmGraph({ projectId: id, rootIssueId, depth }));
  },
);

pmReadRoutes.get(
  '/:id/pm/runner-load',
  zValidator('param', paramSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    await assertMember(id, c.get('userId'));
    return c.json(await readRunnerLoad(id));
  },
);
