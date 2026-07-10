/**
 * Project-scoped integrations router (`/api/projects/:projectId/integrations`).
 *
 * Split for size (behavior-preserving): per-provider schemas + dispatch tables
 * in `provider-schemas.ts`; shared guards/projections in `route-helpers.ts`;
 * the status aggregation in `status-service.ts`; the MCP injection preview in
 * `mcp-preview-service.ts`; the owner-scoped connection router in
 * `connection-routes.ts` (re-exported below for `src/index.ts`).
 */

import { randomBytes } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { integrationDeliveries } from '../db/schema.js';
import { effectiveProjectRole, orgRoleAtLeast } from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { findDeliveryById } from './deliveries.js';
import { buildMcpPreview } from './mcp-preview-service.js';
import {
  applySecretsPatch,
  configSchemaForProvider,
  createSchema,
  splitProviderConfig,
  updateSchema,
} from './provider-schemas.js';
import { enqueueCoolifyDispatch } from './queue.js';
import { getAdapter } from './registry.js';
import { fetchBotRooms } from './rocketchat/rest-client.js';
import {
  alreadyExists,
  assertAdmin,
  assertNoActiveBindingClash,
  assertProjectMember,
  assertVaultConfigured,
  badRequest,
  broadcastIntegrationChanged,
  buildCreatedBindingResponse,
  forbidden,
  notFound,
  reloadRocketChatIfNeeded,
  summarizeBinding,
} from './route-helpers.js';
import { buildIntegrationsStatusCards } from './status-service.js';
import {
  buildContextFromBinding,
  createBinding,
  createConnection,
  findActiveBindingByLabel,
  findBindingWithConnectionById,
  listBindingsForProject,
  softDeleteBinding,
  softDeleteConnection,
  updateBinding,
  updateConnection,
} from './store.js';

// Owner-scoped connection CRUD lives in its own module; re-exported so
// `src/index.ts` keeps importing both routers from `./integrations/routes.js`.
export { integrationConnectionsRoutes } from './connection-routes.js';

export const integrationsRoutes = new Hono<{ Variables: AuthVars }>();
integrationsRoutes.use('*', requireAuth(), assertEmailVerified());

integrationsRoutes.get('/:projectId/integrations', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  const pairs = await listBindingsForProject(projectId);
  return c.json({ items: pairs.map(summarizeBinding) });
});

integrationsRoutes.post(
  '/:projectId/integrations',
  zValidator('json', createSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const projectId = c.req.param('projectId');
    const userId = c.get('userId');
    const role = await assertProjectMember(projectId, userId);
    assertAdmin(role);

    assertVaultConfigured();

    const body = c.req.valid('json');

    // ISS-558 — epodsystem allows N labeled bindings per (project, env).
    // The unique index is now (project_id, provider, environment, label), so
    // we check by label for epodsystem and by env-only for other providers.
    const bindingLabel =
      body.provider === 'epodsystem' && 'label' in body && body.label ? body.label : '';

    if (body.provider === 'epodsystem') {
      // For epodsystem check the specific label slot ('' = default, or named).
      const clash = await findActiveBindingByLabel(
        projectId,
        body.provider,
        body.environment,
        bindingLabel,
      );
      if (clash) {
        const labelSuffix = bindingLabel ? ` (label "${bindingLabel}")` : '';
        throw alreadyExists(
          `integration already exists for this provider+environment${labelSuffix}`,
        );
      }
    } else {
      // Non-epodsystem: one active binding per (project, provider, env) as before.
      await assertNoActiveBindingClash(projectId, body.provider, body.environment);
    }

    // Auto-mint a per-binding HMAC secret for inbound webhook verification.
    const integrationSecret = `whsec_${randomBytes(24).toString('hex')}`;

    // Create the credential (connection) then bind it into this project+env.
    // Connection-tier config (e.g. coolify baseUrl) lives on the connection;
    // binding-tier deploy-target fields (coolify resourceUuid/branch) live on
    // the binding so a later share to another project can override them.
    // orgId present = org-owned credential: it must be the project's own
    // org and the caller must be an org admin (org connections only bind
    // within their org).
    if (body.orgId) {
      const access = await effectiveProjectRole(userId, projectId);
      if (!access || access.orgId !== body.orgId) {
        throw new HTTPException(409, {
          message: 'org connection must belong to the project’s own org',
          cause: { code: 'ORG_MISMATCH' },
        });
      }
      if (!orgRoleAtLeast(access.orgRole, 'admin')) throw forbidden();
    }
    const tiers = splitProviderConfig(body.provider, body.config);
    const connection = await createConnection({
      ownerType: body.orgId ? 'org' : 'user',
      ownerId: body.orgId ?? userId,
      provider: body.provider,
      config: { ...tiers.connection, environment: body.environment },
      secrets: body.secrets,
    });
    let binding: Awaited<ReturnType<typeof createBinding>>;
    try {
      binding = await createBinding({
        connectionId: connection.id,
        projectId,
        provider: body.provider,
        environment: body.environment,
        config: tiers.binding,
        integrationSecret,
        label: bindingLabel,
      });
    } catch (err) {
      // Roll the just-created connection back so a binding-unique collision
      // doesn't leave a dangling credential.
      await softDeleteConnection(connection.id).catch(() => {});
      if (isUniqueViolation(err)) {
        throw alreadyExists('integration already exists for this provider+environment+label');
      }
      throw err;
    }
    reloadRocketChatIfNeeded(body.provider, connection.id);
    // Probe immediately so the new integration starts with real health (and
    // epodsystem store identity) instead of an unverified card (ISS-429).
    return c.json(
      await buildCreatedBindingResponse({ binding, connection }, integrationSecret),
      201,
    );
  },
);

integrationsRoutes.patch(
  '/:projectId/integrations/:id',
  zValidator('json', updateSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const projectId = c.req.param('projectId');
    const id = c.req.param('id');
    const userId = c.get('userId');
    const role = await assertProjectMember(projectId, userId);
    assertAdmin(role);

    const existing = await findBindingWithConnectionById(id);
    if (!existing || existing.binding.projectId !== projectId) throw notFound();
    const { binding, connection } = existing;

    const patch = c.req.valid('json');

    // Re-validate the loose config against the existing provider so a PATCH can
    // never strip the wrong provider's fields, then split it into tiers:
    // coolify resourceUuid/branch are BINDING-scoped (the deploy target follows
    // the project), the rest merges into the shared connection config.
    let mergedConfig: Record<string, unknown> | undefined;
    let mergedBindingConfig: Record<string, unknown> | undefined;
    if (patch.config) {
      const parsed = configSchemaForProvider(binding.provider).safeParse(patch.config);
      if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
      const tiers = splitProviderConfig(binding.provider, parsed.data as Record<string, unknown>);
      if (Object.keys(tiers.connection).length > 0) {
        mergedConfig = {
          ...((connection.config ?? {}) as object),
          ...tiers.connection,
        };
      }
      if (Object.keys(tiers.binding).length > 0) {
        mergedBindingConfig = {
          ...((binding.config ?? {}) as object),
          ...tiers.binding,
        };
      }
    }

    // Connection-level fields (connection-tier config/secrets/active) of an
    // ORG-owned credential are managed at the org tier — a project admin alone
    // must not rotate or reconfigure a credential shared across the org's
    // projects. Binding-tier deploy-target fields stay project-admin editable:
    // they only affect THIS project's binding.
    if (
      connection.ownerType === 'org' &&
      (mergedConfig !== undefined || patch.secrets !== undefined || patch.active !== undefined)
    ) {
      const access = await effectiveProjectRole(userId, projectId);
      if (!orgRoleAtLeast(access?.orgRole ?? null, 'admin')) throw forbidden();
    }

    let mergedSecrets: Record<string, unknown> | undefined;
    if (patch.secrets) {
      mergedSecrets = await applySecretsPatch({
        provider: binding.provider,
        rawSecrets: patch.secrets,
        secretsEnc: connection.secretsEnc,
        // Historical order on this path: the vault guard is skipped for a
        // config-only PATCH (no credential fields).
        vaultGuardTiming: 'on-secret-input',
      });
    }

    // Connection-tier config + secrets live on the connection; binding-tier
    // config (deploy target) + `active` live on the binding (disabling
    // resolution for this project without touching the credential).
    if (mergedConfig !== undefined || mergedSecrets !== undefined) {
      const connPatch: Parameters<typeof updateConnection>[1] = {};
      if (mergedConfig !== undefined) connPatch.config = mergedConfig;
      if (mergedSecrets !== undefined) connPatch.secrets = mergedSecrets;
      await updateConnection(connection.id, connPatch);
    }
    if (mergedBindingConfig !== undefined || patch.active !== undefined) {
      const bindingPatch: Parameters<typeof updateBinding>[1] = {};
      if (mergedBindingConfig !== undefined) bindingPatch.config = mergedBindingConfig;
      if (patch.active !== undefined) bindingPatch.active = patch.active;
      await updateBinding(binding.id, bindingPatch);
    }

    const refreshed = await findBindingWithConnectionById(id);
    if (!refreshed) throw notFound();
    broadcastIntegrationChanged(projectId, { bindingId: id, connectionId: connection.id });
    reloadRocketChatIfNeeded(binding.provider, connection.id);
    return c.json({ integration: summarizeBinding(refreshed) });
  },
);

integrationsRoutes.delete('/:projectId/integrations/:id', async (c) => {
  const projectId = c.req.param('projectId');
  const id = c.req.param('id');
  const userId = c.get('userId');
  const role = await assertProjectMember(projectId, userId);
  assertAdmin(role);

  const existing = await findBindingWithConnectionById(id);
  if (!existing || existing.binding.projectId !== projectId) throw notFound();

  // Soft-delete the binding (stops resolution for this project). The connection
  // is left intact — it may be shared by other projects, and credential removal
  // is an owner-scoped action on the connection itself.
  await softDeleteBinding(id);
  broadcastIntegrationChanged(projectId, {
    bindingId: id,
    connectionId: existing.connection.id,
  });
  reloadRocketChatIfNeeded(existing.binding.provider, existing.connection.id);
  return c.json({ ok: true });
});

integrationsRoutes.post('/:projectId/integrations/:id/test', async (c) => {
  const projectId = c.req.param('projectId');
  const id = c.req.param('id');
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  const existing = await findBindingWithConnectionById(id);
  if (!existing || existing.binding.projectId !== projectId) throw notFound();

  const adapter = getAdapter(existing.binding.provider);
  if (!adapter) {
    throw new HTTPException(400, {
      message: `no adapter registered for provider=${existing.binding.provider}`,
      cause: { code: 'NO_ADAPTER' },
    });
  }
  const ctx = buildContextFromBinding(existing);
  const result = await adapter.healthcheck(ctx);
  return c.json(result);
});

// List the Rocket.Chat rooms the bot can serve, so the UI offers a name picker
// instead of making the operator dig up raw rids. Two modes: `integrationId`
// reuses the stored (decrypted) bot credential of an existing binding; the
// bare credential fields serve the first-time connect form, before anything
// is persisted. Rooms = whatever the bot user is a member of (channels +
// private groups) — exactly the set it can read/reply in.
const rocketchatRoomsSchema = z
  .object({
    integrationId: z.string().uuid().optional(),
    serverUrl: z.string().url().max(500).optional(),
    authToken: z.string().min(8).max(2000).optional(),
    userId: z.string().min(1).max(200).optional(),
  })
  .refine((b) => b.integrationId || (b.serverUrl && b.authToken && b.userId), {
    message: 'pass integrationId, or serverUrl + authToken + userId',
  });

integrationsRoutes.post(
  '/:projectId/integrations/rocketchat/rooms',
  zValidator('json', rocketchatRoomsSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const projectId = c.req.param('projectId');
    const userId = c.get('userId');
    await assertProjectMember(projectId, userId);
    const body = c.req.valid('json');

    let auth: { serverUrl: string; authToken: string; userId: string };
    if (body.integrationId) {
      const existing = await findBindingWithConnectionById(body.integrationId);
      if (
        !existing ||
        existing.binding.projectId !== projectId ||
        existing.binding.provider !== 'rocketchat'
      ) {
        throw notFound();
      }
      const ctx = buildContextFromBinding(existing);
      const cfg = ctx.config as { serverUrl?: string } | null;
      const secrets = ctx.secrets as { authToken?: string; userId?: string } | null;
      if (!cfg?.serverUrl || !secrets?.authToken || !secrets?.userId) {
        throw new HTTPException(409, {
          message: 'rocketchat connection is missing serverUrl/credentials',
          cause: { code: 'MISSING_CREDENTIALS' },
        });
      }
      auth = { serverUrl: cfg.serverUrl, authToken: secrets.authToken, userId: secrets.userId };
    } else {
      auth = {
        serverUrl: (body.serverUrl as string).replace(/\/+$/, ''),
        authToken: body.authToken as string,
        userId: body.userId as string,
      };
    }

    const rooms = (await fetchBotRooms(auth)).slice(0, 200);
    return c.json({ rooms });
  },
);

integrationsRoutes.post('/:projectId/integrations/:id/rotate-secret', async (c) => {
  const projectId = c.req.param('projectId');
  const id = c.req.param('id');
  const userId = c.get('userId');
  const role = await assertProjectMember(projectId, userId);
  assertAdmin(role);

  const existing = await findBindingWithConnectionById(id);
  if (!existing || existing.binding.projectId !== projectId) throw notFound();

  // The inbound HMAC secret is per-binding (an inbound webhook is project+env
  // scoped), so rotation targets the binding.
  const newSecret = `whsec_${randomBytes(24).toString('hex')}`;
  await updateBinding(id, { integrationSecret: newSecret });
  const refreshed = await findBindingWithConnectionById(id);
  if (!refreshed) throw notFound();
  broadcastIntegrationChanged(projectId, {
    bindingId: id,
    connectionId: existing.connection.id,
  });
  return c.json({ integration: summarizeBinding(refreshed), integrationSecret: newSecret });
});

integrationsRoutes.post('/:projectId/integrations/:id/confirm-prod-deploy', async (c) => {
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
  // Lazy import to avoid an import cycle (release-coolify imports the
  // adapter, which would transitively import these routes).
  const { confirmPendingProdDeploy } = await import('../pipeline/release-coolify.js');
  const result = await confirmPendingProdDeploy(id);
  broadcastIntegrationChanged(projectId, {
    bindingId: id,
    connectionId: existing.connection.id,
  });
  return c.json(result);
});

integrationsRoutes.get('/:projectId/integrations/:id/deliveries', async (c) => {
  const projectId = c.req.param('projectId');
  const id = c.req.param('id');
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  const existing = await findBindingWithConnectionById(id);
  if (!existing || existing.binding.projectId !== projectId) throw notFound();

  const rows = await db
    .select()
    .from(integrationDeliveries)
    .where(eq(integrationDeliveries.bindingId, id))
    .orderBy(desc(integrationDeliveries.createdAt))
    .limit(50);
  return c.json({ items: rows });
});

// Re-dispatch a failed outbound delivery. Async by design: we re-enqueue the
// SAME outbound path the original used (enqueueCoolifyDispatch → worker →
// coolifyAdapter.dispatchOutbound) with a FRESH requestId, so the worker/adapter
// records the new delivery row. The route must NOT pre-record it — the
// (binding_id, request_id) partial unique index would collide. Outbound
// deliveries are Coolify-only today (postman/epodsystem are MCP-injection with
// no outbound), so the `direction==='outbound'` guard scopes retry correctly
// without per-provider branching.
integrationsRoutes.post('/:projectId/integrations/:id/deliveries/:deliveryId/retry', async (c) => {
  const projectId = c.req.param('projectId');
  const id = c.req.param('id');
  const deliveryId = c.req.param('deliveryId');
  const userId = c.get('userId');
  const role = await assertProjectMember(projectId, userId);
  assertAdmin(role);

  const existing = await findBindingWithConnectionById(id);
  if (!existing || existing.binding.projectId !== projectId) throw notFound();

  const delivery = await findDeliveryById(deliveryId);
  if (!delivery || delivery.bindingId !== id) throw notFound('delivery');

  if (delivery.direction !== 'outbound' || delivery.status !== 'failed') {
    throw new HTTPException(409, {
      message: 'only failed outbound deliveries can be retried',
      cause: { code: 'NOT_RETRYABLE' },
    });
  }

  // Carry the original tracking keys forward; a fresh requestId keeps the new
  // delivery row distinct and stops pg-boss's singletonKey from collapsing it.
  const p = (delivery.payload ?? {}) as { runId?: string | null; issueId?: string | null };
  const requestId = `retry_${randomBytes(12).toString('hex')}`;
  await enqueueCoolifyDispatch({
    jobKind: 'coolify.dispatch',
    bindingId: id,
    runId: p.runId ?? null,
    issueId: p.issueId ?? null,
    eventName: delivery.eventName,
    requestId,
  });
  return c.json({ requestId, queued: true }, 202);
});

// ISS-305 — composed read-only integrations status for the web hub; the
// aggregation lives in status-service.ts.
integrationsRoutes.get('/:projectId/integrations/status', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  return c.json({ cards: await buildIntegrationsStatusCards(projectId) });
});

// MCP injection preview (ISS-429) — mirrors dispatch-time resolution; the
// projection lives in mcp-preview-service.ts (a documented drift pair with
// src/jobs/resolve-job-mcp-servers.ts).
integrationsRoutes.get('/:projectId/integrations/mcp-preview', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  return c.json({ servers: await buildMcpPreview(projectId) });
});
