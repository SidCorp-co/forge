import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type SpawnPmSessionResult, spawnPmSession } from './spawner.js';

const projectIdParam = z.object({ projectId: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const conflict = (message: string, code: string) =>
  new HTTPException(409, { message, cause: { code } });

const tooManyRequests = (message: string, code: string) =>
  new HTTPException(429, { message, cause: { code } });

function reasonToCode(reason: Exclude<SpawnPmSessionResult, { ok: true }>['reason']): string {
  return reason.toUpperCase().replace(/-/g, '_');
}

export const pmRoutes = new Hono<{ Variables: AuthVars }>();

/**
 * Operator endpoint — force a PM run for a project. Requires project
 * membership. Operator-cause spawns bypass both the trigger mask and the
 * `max_runs_per_hour` rate limit so a human can always force a run during
 * triage. The dedup unique index still applies — a second click while a
 * PM job is in flight returns 409.
 */
pmRoutes.post(
  '/:projectId/pm/run',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    if (!access.role && access.ownerId !== userId) {
      throw forbidden('not a project member');
    }
    const result = await spawnPmSession({
      projectId,
      cause: 'operator',
      actorUserId: userId,
    });
    if (!result.ok) {
      const code = reasonToCode(result.reason);
      if (result.reason === 'rate-limited') {
        throw tooManyRequests(result.reason, code);
      }
      throw conflict(result.reason, code);
    }
    return c.json({ ok: true, jobId: result.jobId });
  },
);
