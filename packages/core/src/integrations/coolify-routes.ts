/**
 * The Coolify deploy commands over REST, so an agent on the CLI can reach them
 * without `forge_coolify_deploy`.
 *
 * Registered ONTO `integrationsRoutes` rather than mounted as a second router
 * on `/api/projects`: a sub-app's `use('*')` covers every path under its mount
 * prefix whether or not it handles them (ISS-719), so a second router there
 * would put another auth chain in front of every project route. The handlers
 * live here to keep routes.ts inside its size budget; the registration is two
 * lines there.
 *
 * `coolify` is a literal segment among sibling routes that take `:id`. No GET
 * on `/:projectId/integrations/:id` exists today, so nothing shadows it — but
 * adding one would, and no test here can see that happen.
 *
 * `confirm-prod-deploy` moved here from routes.ts with the rest: it is a
 * Coolify route that happened to live in the provider-agnostic file.
 */

import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AuthVars } from '../middleware/auth.js';
import {
  CoolifyCommandError,
  coolifyDeliveryStatus,
  listCoolifyIntegrations,
  runCoolifyDeploy,
} from './coolify/commands.js';
import {
  assertAdmin,
  assertProjectMember,
  broadcastIntegrationChanged,
  notFound,
} from './route-helpers.js';
import { findBindingWithConnectionById } from './store.js';

const deployBodySchema = z
  .object({
    issueId: z.uuid().optional(),
    pipelineRunId: z.uuid().optional(),
    integrationId: z.uuid().optional(),
  })
  .strict();

// cm:edge contract -> packages/core/src/integrations/coolify/commands.ts — that module throws a bare sentence so this surface can make it a 400 body; the MCP tool adds its own `BAD_REQUEST:` prefix instead. Mapping it to a 500 here would report a caller's mistake as core's.
const asHttp = (err: unknown): never => {
  if (err instanceof CoolifyCommandError) {
    throw new HTTPException(400, { message: err.message, cause: { code: 'BAD_REQUEST' } });
  }
  throw err;
};

export function registerCoolifyDeployRoutes(routes: Hono<{ Variables: AuthVars }>): void {
  routes.get('/:projectId/integrations/coolify', async (c) => {
    const projectId = c.req.param('projectId');
    await assertProjectMember(projectId, c.get('userId'));
    return c.json(await listCoolifyIntegrations(projectId));
  });

  routes.get('/:projectId/integrations/coolify/status', async (c) => {
    const projectId = c.req.param('projectId');
    await assertProjectMember(projectId, c.get('userId'));
    const integrationId = c.req.query('integrationId');
    try {
      return c.json(
        await coolifyDeliveryStatus({
          projectId,
          ...(integrationId ? { integrationId } : {}),
        }),
      );
    } catch (err) {
      return asHttp(err);
    }
  });

  // cm:guard `member`, matching the MCP tool's `assertPrincipalIsWriter` — NOT admin. The prod decision is not made here: `runCoolifyDeploy` earns `allowProd` per branch and `dispatchCoolifyDeployDirect` refuses a prod binding on its own, so raising the floor here would only block staging deploys while changing nothing about prod.
  routes.post('/:projectId/integrations/coolify/deploy', async (c) => {
    const projectId = c.req.param('projectId');
    await assertProjectMember(projectId, c.get('userId'));

    const raw = await c.req.json().catch(() => ({}));
    const parsed = deployBodySchema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(parsed.error) },
      });
    }

    try {
      return c.json(await runCoolifyDeploy({ projectId, ...parsed.data }));
    } catch (err) {
      return asHttp(err);
    }
  });

  routes.post('/:projectId/integrations/:id/confirm-prod-deploy', async (c) => {
    const projectId = c.req.param('projectId');
    const id = c.req.param('id');
    const userId = c.get('userId');
    const role = await assertProjectMember(projectId, userId);
    assertAdmin(role);

    const existing = await findBindingWithConnectionById(id);
    if (!existing || existing.binding.projectId !== projectId) throw notFound();
    if (existing.binding.environment !== 'prod') {
      throw new HTTPException(400, {
        message: 'confirm-prod-deploy is only valid on prod-environment integrations',
        cause: { code: 'NOT_PROD_ENV' },
      });
    }
    // cm:guard keep this import lazy — `release-coolify` imports the Coolify adapter, which transitively imports this module, so a top-level import closes the cycle. The commands module above can import it eagerly because nothing imports the commands module back.
    const { confirmPendingProdDeploy } = await import('../pipeline/release-coolify.js');
    const result = await confirmPendingProdDeploy(id);
    broadcastIntegrationChanged(projectId, {
      bindingId: id,
      connectionId: existing.connection.id,
    });
    return c.json(result);
  });
}
