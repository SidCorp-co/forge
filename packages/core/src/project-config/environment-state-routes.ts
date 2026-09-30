import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertProjectAccess } from '../lib/authz.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { deployAdapterForBinding } from './deploy-adapters/index.js';
import { EnvironmentStateError, resolveEnvironmentState } from './environment-state.js';
import { readProjectDocument } from './service.js';

const PLATFORM_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;

const paramSchema = z.object({
  id: z.uuid(),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
});

export const environmentStateRoutes = new Hono<{ Variables: AuthVars }>();
environmentStateRoutes.use('/:id/environments/*', requireAuth(), assertEmailVerified());

environmentStateRoutes.get(
  '/:id/environments/:name/state',
  zValidator('param', paramSchema, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: 'a project id is a uuid and an environment name matches ^[a-z][a-z0-9-]{0,62}$',
        cause: { code: 'BAD_REQUEST' },
      });
    }
  }),
  async (c) => {
    const { id, name } = c.req.valid('param');
    await assertProjectAccess(id, c.get('userId'), 'viewer');

    const stored = await readProjectDocument(id);
    if (!stored) {
      throw new HTTPException(404, {
        message: `project ${id} has declared no project document, so it names no environment`,
        cause: { code: 'PROJECT_DOCUMENT_NOT_FOUND' },
      });
    }
    const decl = Object.hasOwn(stored.document.environments, name)
      ? stored.document.environments[name]
      : undefined;
    if (!decl) {
      const declared = Object.keys(stored.document.environments).join(', ') || 'none';
      throw new HTTPException(404, {
        message: `project document revision ${stored.revision} declares no environment \`${name}\` (declared: ${declared})`,
        cause: { code: 'ENVIRONMENT_NOT_FOUND' },
      });
    }

    try {
      const state = await resolveEnvironmentState(name, decl, {
        deployAdapterFor: (bindingId) =>
          deployAdapterForBinding(id, bindingId, PLATFORM_TIMEOUT_MS),
        fetch,
        probeTimeoutMs: PROBE_TIMEOUT_MS,
        onProbe: (environment, outcome) => {
          if (!outcome.ok) {
            logger.warn(
              { projectId: id, environment, url: outcome.probe.url, reason: outcome.reason },
              'environment state: runtime probe did not answer',
            );
          }
        },
      });
      return c.json(state);
    } catch (err) {
      if (err instanceof z.ZodError) throw err;
      if (err instanceof EnvironmentStateError) {
        throw new HTTPException(409, { message: err.message, cause: { code: err.code } });
      }
      const why = err instanceof Error ? err.message : String(err);
      throw new HTTPException(502, {
        message: `the deployment record of environment \`${name}\` could not be read: ${why}`,
        cause: { code: 'DEPLOYMENT_RECORD_UNREADABLE' },
      });
    }
  },
);
