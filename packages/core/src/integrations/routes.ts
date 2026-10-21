/**
 * Project-scoped integrations router (`/api/projects/:projectId/integrations`).
 *
 * Split for size (behavior-preserving): per-provider schemas + dispatch tables
 * in `provider-schemas.ts`; shared guards/projections in `route-helpers.ts`;
 * the status aggregation in `status-service.ts`; the MCP server preview in
 * `mcp-preview-service.ts`; the owner-scoped connection router in
 * `connection-routes.ts` (re-exported below for `src/index.ts`).
 */

import { randomBytes } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { db } from '../db/client.js';
import { integrationDeliveries } from '../db/schema.js';
import { effectiveProjectRole, orgRoleAtLeast } from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { AGENT_ACCESS_CLOSED, type AgentAccess } from './agent-access.js';
import { registerCoolifyDeployRoutes } from './coolify/routes.js';
import { findDeliveryById } from './deliveries.js';
import { healthAnswer } from './health-words.js';
import { buildMcpPreview } from './mcp-preview-service.js';
import {
  applySecretsPatch,
  bindingConfigPatch,
  createSchema,
  splitProviderConfig,
  updateSchema,
} from './provider-schemas.js';
import { enqueueOutboundDispatch } from './queue.js';
import { getAdapter } from './registry.js';
import { withdrawNulls } from './release-channel-schema.js';
import { rocketChatBindingOfProject } from './rocketchat/binding.js';
import { fetchBotRooms } from './rocketchat/rest-client.js';
import {
  alreadyExists,
  assertAdmin,
  assertNoActiveBindingClash,
  assertNotRemoved,
  assertProjectMember,
  assertVaultConfigured,
  authorizeAgentAccessWrite,
  badRequest,
  broadcastIntegrationChanged,
  buildCreatedBindingResponse,
  defaultConnectionDisplayName,
  forbidden,
  notFound,
  notifyConnectionChanged,
  summarizeBinding,
} from './route-helpers.js';
import {
  bindingChangedSchema,
  bindingListSchema,
  createdBindingSchema,
  createIntegration,
  deliveryListSchema,
  healthResultSchema,
  listDeliveries,
  listIntegrations,
  listRocketchatRooms,
  mcpPreviewSchema,
  okSchema,
  previewMcpServers,
  readIntegrationsStatus,
  removeIntegration,
  retryDelivery,
  retryQueuedSchema,
  rocketchatRoomsSchema,
  roomsSchema,
  rotatedSecretSchema,
  rotateIntegrationSecret,
  statusCardsSchema,
  testIntegration,
  updateIntegration,
} from './routes-reference.js';
import { buildIntegrationsStatusCards } from './status-service.js';
import {
  buildContextFromBinding,
  createBinding,
  createConnection,
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

registerCoolifyDeployRoutes(integrationsRoutes);

integrationsRoutes.get('/:projectId/integrations', ...listIntegrations, async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  const pairs = await listBindingsForProject(projectId);
  // One array under both keys: `items` is the alias the `forge` CLI and the runner read (ISS-1191).
  const bindings = pairs.map(summarizeBinding);
  return c.json(answer(bindingListSchema, { bindings, items: bindings }));
});

integrationsRoutes.post(
  '/:projectId/integrations',
  ...createIntegration,
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

    const bindingLabel = 'label' in body && body.label ? body.label : '';
    await assertNoActiveBindingClash(projectId, body.provider, body.role, bindingLabel);

    const integrationSecret = `whsec_${randomBytes(24).toString('hex')}`;

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
    // Connecting an integration and saying whether agents may use it is ONE act on ONE object
    // (ISS-1071 rule 3). The default is closed, so a caller that does not ask grants nothing.
    const bindingAgentAccess: AgentAccess = body.agentAccess ?? AGENT_ACCESS_CLOSED;
    if (bindingAgentAccess !== AGENT_ACCESS_CLOSED) {
      await authorizeAgentAccessWrite(userId, projectId, body.provider);
    }
    const tiers = splitProviderConfig(body.provider, body.config);
    const connection = await createConnection({
      ownerType: body.orgId ? 'org' : 'user',
      ownerId: body.orgId ?? userId,
      provider: body.provider,
      displayName: defaultConnectionDisplayName(tiers.connection),
      config: tiers.connection,
      secrets: body.secrets,
    });
    let binding: Awaited<ReturnType<typeof createBinding>>;
    try {
      binding = await createBinding({
        connectionId: connection.id,
        projectId,
        provider: body.provider,
        role: body.role,
        ...(body.role === 'deploy' && body.stages ? { stages: body.stages } : {}),
        config: tiers.binding,
        integrationSecret,
        label: bindingLabel,
        agentAccess: bindingAgentAccess,
      });
    } catch (err) {
      // Roll the just-created connection back so a binding-unique collision
      // doesn't leave a dangling credential.
      await softDeleteConnection(connection.id).catch(() => {});
      if (isUniqueViolation(err)) {
        throw alreadyExists(
          'an active service binding for this provider and label already exists on this project',
        );
      }
      throw err;
    }
    notifyConnectionChanged(body.provider, connection.id);
    // Probe immediately so the new integration starts with real health (and
    // epodsystem store identity) instead of an unverified card (ISS-429).
    return c.json(
      answer(
        createdBindingSchema,
        await buildCreatedBindingResponse({ binding, connection }, integrationSecret),
      ),
      201,
    );
  },
);

integrationsRoutes.patch(
  '/:projectId/integrations/:id',
  ...updateIntegration,
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
      const config = bindingConfigPatch(binding.provider, patch.config);
      const tiers = splitProviderConfig(binding.provider, config);
      if (Object.keys(tiers.connection).length > 0) {
        mergedConfig = withdrawNulls({
          ...((connection.config ?? {}) as object),
          ...tiers.connection,
        });
      }
      if (Object.keys(tiers.binding).length > 0) {
        mergedBindingConfig = withdrawNulls({
          ...((binding.config ?? {}) as object),
          ...tiers.binding,
        });
      }
    }

    // Connection-tier config and secrets of an ORG-owned credential are managed
    // at the org tier: a project admin alone must not rotate a credential the
    // org's projects share. Binding-tier fields stay project-admin editable,
    // `active` among them — the tier split below writes it to the binding, and
    // DELETE throws that same switch for a project admin alone (ISS-1115).
    if (
      connection.ownerType === 'org' &&
      (mergedConfig !== undefined || patch.secrets !== undefined)
    ) {
      const access = await effectiveProjectRole(userId, projectId);
      if (!orgRoleAtLeast(access?.orgRole ?? null, 'admin')) throw forbidden();
    }

    if (patch.agentAccess !== undefined) {
      await authorizeAgentAccessWrite(userId, projectId, binding.provider);
    }

    // `stages` describes where a DEPLOY binding sends code. A service binding
    // sends none, and the DB check holds it at zero stages, so a patch carrying
    // them is refused here rather than as a constraint violation.
    if (patch.stages !== undefined && binding.role !== 'deploy') {
      throw new HTTPException(400, {
        message: `stages say where a deploy binding sends code; this binding's role is \`${binding.role}\`, which sends none. Change the role, or leave stages off this patch.`,
        cause: { code: 'STAGES_ON_NON_DEPLOY_BINDING', details: { role: binding.role } },
      });
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
    if (
      mergedBindingConfig !== undefined ||
      patch.active !== undefined ||
      patch.instructions !== undefined ||
      patch.agentAccess !== undefined ||
      patch.stages !== undefined
    ) {
      const bindingPatch: Parameters<typeof updateBinding>[1] = {};
      if (mergedBindingConfig !== undefined) bindingPatch.config = mergedBindingConfig;
      if (patch.active !== undefined) bindingPatch.active = patch.active;
      if (patch.instructions !== undefined) bindingPatch.instructions = patch.instructions;
      if (patch.agentAccess !== undefined) bindingPatch.agentAccess = patch.agentAccess;
      if (patch.stages !== undefined) bindingPatch.stages = patch.stages;
      await updateBinding(binding.id, bindingPatch);
    }

    const refreshed = await findBindingWithConnectionById(id);
    if (!refreshed) throw notFound();
    broadcastIntegrationChanged(projectId, { bindingId: id, connectionId: connection.id });
    notifyConnectionChanged(binding.provider, connection.id);
    return c.json(answer(bindingChangedSchema, { integration: summarizeBinding(refreshed) }));
  },
);

integrationsRoutes.delete('/:projectId/integrations/:id', ...removeIntegration, async (c) => {
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
  notifyConnectionChanged(existing.binding.provider, existing.connection.id);
  return c.json(answer(okSchema, { ok: true }));
});

integrationsRoutes.post('/:projectId/integrations/:id/test', ...testIntegration, async (c) => {
  const { projectId, id } = c.req.param();
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  const existing = await findBindingWithConnectionById(id);
  if (!existing || existing.binding.projectId !== projectId) throw notFound();
  assertNotRemoved(existing.connection, 'tested');

  const adapter = getAdapter(existing.binding.provider);
  if (!adapter) {
    throw new HTTPException(400, {
      message: `no adapter registered for provider=${existing.binding.provider}`,
      cause: { code: 'NO_ADAPTER' },
    });
  }
  const result = await adapter.healthcheck(buildContextFromBinding(existing));
  return c.json(answer(healthResultSchema, healthAnswer(existing.binding.provider, result)));
});

integrationsRoutes.post(
  '/:projectId/integrations/rocketchat/rooms',
  ...listRocketchatRooms,
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
      const existing = await rocketChatBindingOfProject(projectId, body.integrationId);
      if (!existing) throw notFound();
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
    return c.json(answer(roomsSchema, { rooms }));
  },
);

integrationsRoutes.post(
  '/:projectId/integrations/:id/rotate-secret',
  ...rotateIntegrationSecret,
  async (c) => {
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
    return c.json(
      answer(rotatedSecretSchema, {
        integration: summarizeBinding(refreshed),
        integrationSecret: newSecret,
      }),
    );
  },
);

integrationsRoutes.get('/:projectId/integrations/:id/deliveries', ...listDeliveries, async (c) => {
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
  return c.json(answer(deliveryListSchema, { items: rows }));
});

// Re-dispatch a failed outbound delivery. Async by design: we re-enqueue the SAME outbound path
// the original used (enqueueOutboundDispatch → worker → dispatchThrough → that binding's own
// adapter) with a FRESH requestId, so the worker/adapter records the new delivery row. The route
// must NOT pre-record it — the (binding_id, request_id) partial unique index would collide.
integrationsRoutes.post(
  '/:projectId/integrations/:id/deliveries/:deliveryId/retry',
  ...retryDelivery,
  async (c) => {
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

    const p = (delivery.payload ?? {}) as { runId?: string | null; issueId?: string | null };
    const requestId = `retry_${randomBytes(12).toString('hex')}`;
    await enqueueOutboundDispatch({
      jobKind: 'coolify.dispatch',
      bindingId: id,
      runId: p.runId ?? null,
      issueId: p.issueId ?? null,
      eventName: delivery.eventName,
      requestId,
      payload: (delivery.payload ?? {}) as Record<string, unknown>,
    });
    return c.json(answer(retryQueuedSchema, { requestId, queued: true }), 202);
  },
);

// ISS-305 — composed read-only integrations status for the web hub; the
// aggregation lives in status-service.ts.
integrationsRoutes.get('/:projectId/integrations/status', ...readIntegrationsStatus, async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  return c.json(
    answer(statusCardsSchema, { cards: await buildIntegrationsStatusCards(projectId) }),
  );
});

// MCP preview (ISS-429, ISS-1191) — every server a project-wide agent session receives, composed
// in mcp-preview-service.ts from resolveSessionMcpServers, so nothing here resolves a second time.
integrationsRoutes.get('/:projectId/integrations/mcp-preview', ...previewMcpServers, async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  return c.json(answer(mcpPreviewSchema, await buildMcpPreview(projectId)));
});
