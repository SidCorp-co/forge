/**
 * The ops snapshot over REST, in the two shapes its callers actually use.
 *
 * `readOpsHealth` takes a list of project ids, and the two routes here differ
 * only in what they put in that list. Measured on forge-beta 2026-09-01 over
 * the tool this replaces: 53 of 55 calls named no project at all, so the
 * fan-out is the real caller and dropping it would have broken them silently.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import { assertProjectRole, loadProjectAccess, loadVisibleProjectIds } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { readLiveness, readOpsHealth } from './service.js';

const projectIdParamSchema = z.object({ id: z.uuid() });
const staleQuerySchema = z.object({
  staleJobThresholdSeconds: z.coerce.number().int().min(60).max(86_400).optional(),
});

const DEFAULT_STALE_JOB_SECONDS = 600;

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const publicHealthRoutes = new Hono();

publicHealthRoutes.get('/health', async (c) => {
  const live = await readLiveness();
  return c.json(
    {
      ok: live.ok,
      db: { ok: live.dbOk },
      queue: { ok: live.queueOk },
      ws: { ok: live.wsOk },
    },
    live.ok ? 200 : 503,
  );
});

// cm:guard a route of its own, never a field on `/health`: `/health` answers 503 when the DB is down, so folding version into it hands a version check a contract that fails exactly when an operator most needs to know which build is running. Unauthenticated for the same reason `forge_version` carried no project scope — measured on forge-beta 2026-09-01, all 290 of that tool's calls named no project, so there is nothing here for the PAT fence to bite on.
publicHealthRoutes.get('/version', (c) =>
  c.json({ version: pkg.version, uptimeSeconds: Math.floor(process.uptime()) }),
);

export const opsHealthProjectRoutes = new Hono<{ Variables: AuthVars }>();
opsHealthProjectRoutes.use('*', requireAuth(), assertEmailVerified());

opsHealthProjectRoutes.get(
  '/:id/ops-health',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', staleQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const { staleJobThresholdSeconds } = c.req.valid('query');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    assertProjectRole(access, 'member', 'not a project member');

    return c.json(
      await readOpsHealth([projectId], staleJobThresholdSeconds ?? DEFAULT_STALE_JOB_SECONDS),
    );
  },
);

export const opsHealthMeRoutes = new Hono<{ Variables: AuthVars }>();
opsHealthMeRoutes.use('/ops-health', requireAuth(), assertEmailVerified());

// cm:edge contract -> packages/core/src/middleware/pat-rest-surface.ts — this lives under `/api/me` and must STAY off PAT_ALLOWED_PREFIXES: it fans out over every project the caller can see, so a token bound to one project would read runners and stuck jobs across all of them. The per-project half above is the PAT-reachable one, and it is reachable only because `/api/projects` fences on the id in the path.
opsHealthMeRoutes.get(
  '/ops-health',
  zValidator('query', staleQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { staleJobThresholdSeconds } = c.req.valid('query');
    const visibleIds = await loadVisibleProjectIds(c.get('userId'));

    return c.json(
      await readOpsHealth(visibleIds, staleJobThresholdSeconds ?? DEFAULT_STALE_JOB_SECONDS),
    );
  },
);
