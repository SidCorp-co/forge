/**
 * The ops snapshot over REST, in the two shapes its callers actually use.
 *
 * `readOpsHealth` takes a list of project ids, and the two routes here differ
 * only in what they put in that list. Measured on forge-beta 2026-09-01 over
 * the tool this replaces: 53 of 55 calls named no project at all, so the
 * fan-out is the real caller and dropping it would have broken them silently.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { sourceCommit } from '../observability/source-commit.js';
import { requireHeld } from '../permissions/index.js';
import { readLiveness, readOpsHealth } from './service.js';

const projectIdParamSchema = z.object({ id: z.uuid() });
const staleQuerySchema = z.object({
  staleJobThresholdSeconds: z.coerce.number().int().min(60).max(86_400).optional(),
});

const DEFAULT_STALE_JOB_SECONDS = 600;

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

// Mounted at `/` and at `/api` both. Only the second carries CORS — `app.use('/api/*',
// corsMiddleware)` covers that prefix and nothing else — and only the second is where the
// web app's client points, so the root copy alone left the page unable to read this.
publicHealthRoutes.get('/version', (c) =>
  c.json({
    version: pkg.version,
    sourceCommit,
    uptimeSeconds: Math.floor(process.uptime()),
  }),
);

export const opsHealthProjectRoutes = new Hono<{ Variables: AuthVars }>();
opsHealthProjectRoutes.use('*', requireAuth(), assertEmailVerified());

opsHealthProjectRoutes.get(
  '/:id/ops-health',
  zValidator('param', projectIdParamSchema),
  zValidator('query', staleQuerySchema),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const { staleJobThresholdSeconds } = c.req.valid('query');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    requireHeld(access, 'project.write');

    return c.json(
      await readOpsHealth([projectId], staleJobThresholdSeconds ?? DEFAULT_STALE_JOB_SECONDS),
    );
  },
);

export { projectHealthRoutes } from './project-health-routes.js';
