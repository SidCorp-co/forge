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
import type { AuthVars } from '../../middleware/auth.js';
import { DeployEnvironmentLockedError } from '../../pipeline/deploy-lock.js';
import {
  assertAdmin,
  assertProjectMember,
  broadcastIntegrationChanged,
  notFound,
} from '../route-helpers.js';
import { buildContextFromBinding, findBindingWithConnectionById } from '../store.js';
import { CoolifyApiError, describeCoolifyForbidden } from './client.js';
import {
  CoolifyCommandError,
  coolifyDeliveryStatus,
  listCoolifyIntegrations,
  runCoolifyDeploy,
} from './commands.js';
import {
  credentialFromSecrets,
  fetchCoolifyApplications,
  listCoolifyRollbackImages,
  resolveCoolifyTargets,
  runCoolifyCancel,
  runCoolifyRollback,
} from './controls.js';
import type { CoolifyConfig, CoolifySecrets } from './types.js';

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

const applicationsBodySchema = z.union([
  z.object({ integrationId: z.uuid() }).strict(),
  z.object({ baseUrl: z.string().url().max(500), apiToken: z.string().min(8).max(2000) }).strict(),
]);

const asHttp = (err: unknown): never => {
  if (err instanceof CoolifyCommandError) {
    throw new HTTPException(400, { message: err.message, cause: { code: 'BAD_REQUEST' } });
  }
  // Coolify's own answer, named: unmapped it reached the caller as a bare INTERNAL_ERROR (ISS-1346).
  if (err instanceof CoolifyApiError) {
    const said =
      err.status === 403
        ? describeCoolifyForbidden(err)
        : `Coolify answered HTTP ${err.status} to ${err.route ?? 'the request Forge made'}`;
    throw new HTTPException(502, { message: said, cause: { code: 'COOLIFY_API_ERROR' } });
  }
  throw err;
};

/**
 * ISS-1279 — a resumed release refused its environment carries a holder, a
 * subject, a since and what ends the hold. `errorHandler` turns anything that
 * is not an `HTTPException` into a bare `INTERNAL_ERROR` in production, so
 * without this the refusal reaches the person pressing the button as nothing
 * at all.
 */
const lockedAsHttp = (err: unknown): never => {
  if (err instanceof DeployEnvironmentLockedError) {
    throw new HTTPException(409, {
      message: err.message,
      cause: { code: err.code },
    });
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
    if (!(existing.binding.stages ?? []).includes('live')) {
      throw new HTTPException(400, {
        message:
          'confirm-prod-deploy is only valid on a deploy binding carrying the `live` stage — this binding serves no live environment, so there is no production deploy for a human to confirm',
        cause: { code: 'NOT_LIVE_BINDING' },
      });
    }
    const { confirmPendingProdDeploy } = await import('../../pipeline/release-coolify.js');
    const result = await confirmPendingProdDeploy(id).catch(lockedAsHttp);
    broadcastIntegrationChanged(projectId, {
      bindingId: id,
      connectionId: existing.connection.id,
    });
    return c.json(result);
  });
}
