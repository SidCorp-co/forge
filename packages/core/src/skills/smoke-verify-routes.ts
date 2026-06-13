import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { issueStatuses } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  NoRunnerOnlineError,
  buildSmokeVerifyReport,
  dispatchSmokeCanaries,
} from './smoke-verify.js';

/**
 * ISS-455 — `GET/POST /api/projects/:projectId/skills/smoke-verify`.
 *
 * Own small route module (mounted in `src/index.ts` next to the other skill
 * routers) so the projects router — whose bootstrap handler is under active
 * change — stays untouched.
 *
 * - GET: the aggregated report (tier-1 computed fresh + latest tier-2 canary
 *   outcomes). Read access = project membership, mirroring
 *   `GET /skill-registrations`.
 * - POST `{ tier?: 1 }` (default): re-run the synchronous tier-1 static checks
 *   and return the fresh report. Membership suffices — zero agent cost.
 * - POST `{ tier: 2, stages? }`: additionally dispatch one `smoke` canary job
 *   per registered stage. Admin-only (it spends agent budget). 409 with
 *   `NO_RUNNER_ONLINE` when no runner is selectable, instead of parking jobs.
 */

const projectParamSchema = z.object({ projectId: z.uuid() });

const postBodySchema = z
  .object({
    tier: z.union([z.literal(1), z.literal(2)]).default(1),
    stages: z.array(z.enum(issueStatuses)).max(issueStatuses.length).optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export const skillSmokeVerifyRoutes = new Hono<{ Variables: AuthVars }>();
skillSmokeVerifyRoutes.use('/:projectId/skills/smoke-verify', requireAuth(), assertEmailVerified());

skillSmokeVerifyRoutes.get(
  '/:projectId/skills/smoke-verify',
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    return c.json(await buildSmokeVerifyReport(projectId));
  },
);

skillSmokeVerifyRoutes.post(
  '/:projectId/skills/smoke-verify',
  zValidator('param', projectParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', postBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const { tier, stages } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (tier === 2) {
      assertProjectRole(access, 'admin', 'only a project admin can run a tier-2 canary');
    } else if (!access.role) {
      throw forbidden('not a project member');
    }

    let canary = null;
    if (tier === 2) {
      try {
        canary = await dispatchSmokeCanaries({ projectId, userId, stages });
      } catch (err) {
        if (err instanceof NoRunnerOnlineError) {
          throw new HTTPException(409, {
            message: err.message,
            cause: { code: err.code },
          });
        }
        throw err;
      }
    }

    // Freshly dispatched canaries surface as PENDING tier-2 entries.
    const report = await buildSmokeVerifyReport(projectId);
    return c.json({ report, canary });
  },
);
