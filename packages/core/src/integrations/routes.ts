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
import {
  AGENT_ACCESS_CLOSED,
  type AgentAccess,
  agentAccessTier,
  noAgentPathMessage,
} from './agent-access.js';
import { registerCoolifyDeployRoutes } from './coolify/routes.js';
import { findDeliveryById } from './deliveries.js';
import { buildMcpPreview } from './mcp-preview-service.js';
import {
  applySecretsPatch,
  configSchemaForProvider,
  createSchema,
  splitProviderConfig,
  updateSchema,
} from './provider-schemas.js';
import { enqueueOutboundDispatch } from './queue.js';
import { getAdapter, getIntegration } from './registry.js';
import { rocketChatBindingOfProject } from './rocketchat/binding.js';
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
  defaultConnectionDisplayName,
  forbidden,
  notFound,
  notifyConnectionChanged,
  summarizeBinding,
} from './route-helpers.js';
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

/**
 * Authorize a write to a binding's agent-access grant, and refuse one that means nothing.
 *
 * ISS-1071 rule 5 — the tier is a property of the provider's declared agent path, not of the route:
 * a `direct-mcp` grant hands the project's credential to a runner box, so it takes the same
 * org-admin escalation that already guards `secrets`, `config` and `active` on an org-owned
 * connection; a `core-mediated` grant only widens who may ask core to make a call core was already
 * making, so it stays with the project-admin fields. A provider declaring no agent path is refused
 * by name rather than storing a column value nothing will ever read.
 */
// cm:edge contract -> packages/core/src/integrations/agent-access.ts — `agentAccessTier` decides
// which of the two this is; adding a third agent path changes the answer there and nowhere here.
async function authorizeAgentAccessWrite(
  userId: string,
  projectId: string,
  provider: string,
): Promise<void> {
  const tier = agentAccessTier(getIntegration(provider));
  if (tier === 'refused') throw badRequest(noAgentPathMessage(provider));
  if (tier !== 'org-admin') return;
  const access = await effectiveProjectRole(userId, projectId);
  if (!orgRoleAtLeast(access?.orgRole ?? null, 'admin')) throw forbidden();
}

export const integrationsRoutes = new Hono<{ Variables: AuthVars }>();
integrationsRoutes.use('*', requireAuth(), assertEmailVerified());

registerCoolifyDeployRoutes(integrationsRoutes);

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

    // cm:guard ONE clash rule, matching the UNIQUE index exactly: (project_id, provider, label)
    // WHERE role = 'service'. There were two, and each dropped half the key — the epodsystem branch
    // asked by label without the role, so a service binding clashed with a DEPLOY one at the same
    // label (the common shape after ISS-1046: all three fleet epodsystem bindings are `deploy`), and
    // the other branch asked by role without the label, so a second NAMED storefront was refused.
    // `label` is NOT NULL DEFAULT '', so the unlabelled providers need no branch of their own.
    const bindingLabel = 'label' in body && body.label ? body.label : '';
    await assertNoActiveBindingClash(projectId, body.provider, body.role, bindingLabel);

    const integrationSecret = `whsec_${randomBytes(24).toString('hex')}`;

    // Create the credential (connection) then bind it into this project.
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
      // cm:edge contract -> packages/core/src/integrations/connection-routes.ts — BOTH create paths must name the connection; this is the one an operator actually walks (project settings → Integrations), and naming only the other one leaves the anonymous rows still arriving
      displayName: defaultConnectionDisplayName(body.provider, tiers.connection),
      // cm:guard the binding's role/stages are NOT mirrored into `connection.config` — the old code
      // wrote `environment` here as well, a second copy `effectiveConfig` then overlaid, so one
      // connection shared across projects carried whichever binding was created last (ISS-1046).
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

    if (patch.agentAccess !== undefined) {
      await authorizeAgentAccessWrite(userId, projectId, binding.provider);
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
      patch.agentAccess !== undefined
    ) {
      const bindingPatch: Parameters<typeof updateBinding>[1] = {};
      if (mergedBindingConfig !== undefined) bindingPatch.config = mergedBindingConfig;
      if (patch.active !== undefined) bindingPatch.active = patch.active;
      // cm:why project-admin editable without the org-owner escalation above — instructions are per-project prompt text, not a shared credential, so a project admin scoping their own store's guidance touches nothing another project can see
      if (patch.instructions !== undefined) bindingPatch.instructions = patch.instructions;
      if (patch.agentAccess !== undefined) bindingPatch.agentAccess = patch.agentAccess;
      await updateBinding(binding.id, bindingPatch);
    }

    const refreshed = await findBindingWithConnectionById(id);
    if (!refreshed) throw notFound();
    broadcastIntegrationChanged(projectId, { bindingId: id, connectionId: connection.id });
    notifyConnectionChanged(binding.provider, connection.id);
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
  notifyConnectionChanged(existing.binding.provider, existing.connection.id);
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

// Re-dispatch a failed outbound delivery. Async by design: we re-enqueue the SAME outbound path
// the original used (enqueueOutboundDispatch → worker → dispatchThrough → that binding's own
// adapter) with a FRESH requestId, so the worker/adapter records the new delivery row. The route
// must NOT pre-record it — the (binding_id, request_id) partial unique index would collide.
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

  // Carry the original request forward WHOLE; a fresh requestId keeps the new
  // delivery row distinct and stops pg-boss's singletonKey from collapsing it.
  // cm:guard `payload` is the recorded request, not a rebuild of it — that is what makes Retry a
  // replay. A Sentry status update names a target label and a status that `{ runId, issueId }`
  // cannot carry, so rebuilding the payload here would re-dispatch a DIFFERENT request under a
  // button that says it repeats the one that failed (ISS-1085).
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
