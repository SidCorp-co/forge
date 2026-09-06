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
  credentialFromSecrets,
  fetchCoolifyApplications,
  listCoolifyRollbackImages,
  resolveCoolifyTargets,
  runCoolifyCancel,
  runCoolifyRollback,
} from './coolify/controls.js';
import type { CoolifyConfig, CoolifySecrets } from './coolify/types.js';
import {
  assertAdmin,
  assertProjectMember,
  broadcastIntegrationChanged,
  notFound,
} from './route-helpers.js';
import { buildContextFromBinding, findBindingWithConnectionById } from './store.js';

const deployBodySchema = z
  .object({
    issueId: z.uuid().optional(),
    pipelineRunId: z.uuid().optional(),
    integrationId: z.uuid().optional(),
  })
  .strict();

const cancelBodySchema = z
  .object({
    integrationId: z.uuid().optional(),
    deploymentUuid: z.string().min(1).max(200).optional(),
  })
  .strict();

const rollbackBodySchema = z
  .object({
    integrationId: z.uuid().optional(),
    resourceUuid: z.string().min(1).max(200).optional(),
    commit: z.string().min(1).max(200),
  })
  .strict();

// cm:edge contract -> packages/web-v2/src/features/integrations/components/coolify-section.tsx — the picker calls this with the credential the operator is STILL TYPING, before any connection row exists, which is the only reason the target list can replace a transcribed uuid on a first save. Requiring `integrationId` here would put the pick-list one save behind the form and hand the operator back the transcription (ISS-925).
const applicationsBodySchema = z.union([
  z.object({ integrationId: z.uuid() }).strict(),
  z.object({ baseUrl: z.string().url().max(500), apiToken: z.string().min(8).max(2000) }).strict(),
]);

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

  // cm:guard `member`, matching the deploy route above and NOT admin: cancel and rollback answer to the SAME prod gate a deploy does — `prodActionNeedsHumanConfirm` inside the commands — so raising the floor here would only block staging while changing nothing about prod (ISS-925).
  routes.post('/:projectId/integrations/coolify/cancel', async (c) => {
    const projectId = c.req.param('projectId');
    await assertProjectMember(projectId, c.get('userId'));
    const raw = await c.req.json().catch(() => ({}));
    const parsed = cancelBodySchema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(parsed.error) },
      });
    }
    try {
      return c.json(await runCoolifyCancel({ projectId, ...parsed.data }));
    } catch (err) {
      return asHttp(err);
    }
  });

  routes.get('/:projectId/integrations/coolify/rollback-images', async (c) => {
    const projectId = c.req.param('projectId');
    await assertProjectMember(projectId, c.get('userId'));
    const integrationId = c.req.query('integrationId');
    const resourceUuid = c.req.query('resourceUuid');
    try {
      return c.json(
        await listCoolifyRollbackImages({
          projectId,
          ...(integrationId ? { integrationId } : {}),
          ...(resourceUuid ? { resourceUuid } : {}),
        }),
      );
    } catch (err) {
      return asHttp(err);
    }
  });

  routes.post('/:projectId/integrations/coolify/rollback', async (c) => {
    const projectId = c.req.param('projectId');
    await assertProjectMember(projectId, c.get('userId'));
    const raw = await c.req.json().catch(() => ({}));
    const parsed = rollbackBodySchema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(parsed.error) },
      });
    }
    try {
      return c.json(await runCoolifyRollback({ projectId, ...parsed.data }));
    } catch (err) {
      return asHttp(err);
    }
  });

  routes.post('/:projectId/integrations/coolify/applications', async (c) => {
    const projectId = c.req.param('projectId');
    await assertProjectMember(projectId, c.get('userId'));
    const raw = await c.req.json().catch(() => ({}));
    const parsed = applicationsBodySchema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(parsed.error) },
      });
    }
    const body = parsed.data;
    let auth: { baseUrl: string; apiToken: string; previousApiToken?: string };
    if ('integrationId' in body) {
      const existing = await findBindingWithConnectionById(body.integrationId);
      if (
        !existing ||
        existing.binding.projectId !== projectId ||
        existing.binding.provider !== 'coolify'
      ) {
        throw notFound();
      }
      const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>(existing);
      if (!ctx.config?.baseUrl || !ctx.secrets?.apiToken) {
        throw new HTTPException(409, {
          message: 'coolify connection is missing baseUrl or apiToken',
          cause: { code: 'MISSING_CREDENTIALS' },
        });
      }
      auth = credentialFromSecrets(ctx.config, ctx.secrets);
    } else {
      auth = { baseUrl: body.baseUrl, apiToken: body.apiToken };
    }
    return c.json({ applications: (await fetchCoolifyApplications(auth)).slice(0, 500) });
  });

  routes.get('/:projectId/integrations/coolify/targets', async (c) => {
    const projectId = c.req.param('projectId');
    await assertProjectMember(projectId, c.get('userId'));
    const integrationId = c.req.query('integrationId');
    try {
      return c.json(
        await resolveCoolifyTargets({
          projectId,
          ...(integrationId ? { integrationId } : {}),
        }),
      );
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
