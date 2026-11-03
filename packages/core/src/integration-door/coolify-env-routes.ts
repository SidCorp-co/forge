/**
 * ISS-827 — the env door on a project's Coolify binding, over REST beside deploy and logs: list the
 * variable names of an application the binding names (every value masked), set one, delete one.
 * Each declares `deploys.run` on the project, as the deploy act does: a production app's variable
 * names are an operator's read, not a viewer's. MCP carries no delivery tool; it names these routes
 * (`forge-door/retired.ts`).
 *
 * The value travels in the body only, never the path or the query, so the request log and the
 * token's act record (both name the path) never hold it.
 */

import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { deleteCoolifyEnv, listCoolifyEnv, setCoolifyEnv } from '../release-batch/index.js';

type Routes = Hono<{ Variables: AuthVars }>;
type Answer = (c: Context, run: () => Promise<unknown>) => Promise<Response>;

/** A POSIX shell variable name: the shape an application's environment can hold. */
const envKey = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'a variable name is letters, digits and _, not starting with a digit',
  )
  .max(255);

const scope = {
  integrationId: z.uuid().optional(),
  resourceUuid: z.string().min(1).max(200).optional(),
};

const envQuerySchema = z.object(scope).strict();

const envParamSchema = z.object({ projectId: z.string(), key: envKey });

const setBodySchema = z
  .object({ ...scope, value: z.string().max(65_536), redeploy: z.boolean().optional() })
  .strict();

const deleteBodySchema = z.object({ ...scope, redeploy: z.boolean().optional() }).strict();

const PARAM = invalid('invalid path: /api/projects/<project id>/integrations/coolify/env/<KEY>');

const coolifyRun = requiresOnParam('deploys.run', 'projectId');

/** `answer` is coolify-routes.ts's: Coolify's own refusal named, never its answer body. */
export function registerCoolifyEnvRoutes(routes: Routes, answer: Answer): void {
  routes.get(
    '/:projectId/integrations/coolify/env',
    coolifyRun,
    zValidator('query', envQuerySchema),
    (c) =>
      answer(c, () =>
        listCoolifyEnv({ projectId: c.req.param('projectId'), ...c.req.valid('query') }),
      ),
  );
  routes.put(
    '/:projectId/integrations/coolify/env/:key',
    coolifyRun,
    zValidator('param', envParamSchema, PARAM),
    zValidator('json', setBodySchema),
    (c) => {
      const { projectId, key } = c.req.valid('param');
      return answer(c, () =>
        setCoolifyEnv({ projectId, key, actorId: c.get('userId') ?? null, ...c.req.valid('json') }),
      );
    },
  );
  routes.delete(
    '/:projectId/integrations/coolify/env/:key',
    coolifyRun,
    zValidator('param', envParamSchema, PARAM),
    zValidator('json', deleteBodySchema),
    (c) => {
      const { projectId, key } = c.req.valid('param');
      return answer(c, () =>
        deleteCoolifyEnv({
          projectId,
          key,
          actorId: c.get('userId') ?? null,
          ...c.req.valid('json'),
        }),
      );
    },
  );
}
