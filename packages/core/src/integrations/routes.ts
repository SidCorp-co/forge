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
import { db } from '../db/client.js';
import { integrationDeliveries } from '../db/schema.js';
import { effectiveProjectRole, orgRoleAtLeast } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { registerCoolifyDeployRoutes } from './coolify/routes.js';
import { findDeliveryById } from './deliveries.js';
import { buildMcpPreview } from './mcp-preview-service.js';
import {
  applySecretsPatch,
  configSchemaForProvider,
  splitProviderConfig,
  updateSchema,
} from './provider-schemas.js';
import { enqueueOutboundDispatch } from './queue.js';
import { withdrawNulls } from './release-channel-schema.js';
import { rocketChatBindingOfProject } from './rocketchat/binding.js';
import { fetchBotRooms } from './rocketchat/rest-client.js';
import {
  adapterOrRefuse,
  assertAdmin,
  assertProjectMember,
  bindingWriteMoved,
  broadcastIntegrationChanged,
  forbidden,
  notFound,
  notifyConnectionChanged,
  summarizeBinding,
} from './route-helpers.js';
import { buildIntegrationsStatusCards } from './status-service.js';
import {
  type BindingWithConnection,
  buildContextFromBinding,
  findBindingWithConnectionById,
  listBindingsForProject,
  setBindingInboundSecret,
  updateConnection,
} from './store.js';

// Owner-scoped connection CRUD lives in its own module; re-exported so
// `src/index.ts` keeps importing both routers from `./integrations/routes.js`.
export { integrationConnectionsRoutes } from './connection-routes.js';

export const integrationsRoutes = new Hono<{ Variables: AuthVars }>();
integrationsRoutes.use('*', requireAuth(), assertEmailVerified());

registerCoolifyDeployRoutes(integrationsRoutes);

/** The binding `id` of this project, after the caller's membership (and, for `admin`, role). */
async function projectBinding(
  projectId: string,
  id: string,
  userId: string,
  need?: 'admin',
): Promise<BindingWithConnection> {
  const role = await assertProjectMember(projectId, userId);
  if (need === 'admin') assertAdmin(role);
  const existing = await findBindingWithConnectionById(id);
  if (!existing || existing.binding.projectId !== projectId) throw notFound();
  return existing;
}

integrationsRoutes.get('/:projectId/integrations', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  const pairs = await listBindingsForProject(projectId);
  // One array under both keys: `items` is the alias the `forge` CLI and the runner read (ISS-1191).
  const bindings = pairs.map(summarizeBinding);
  return c.json({ bindings, items: bindings });
});

integrationsRoutes.post('/:projectId/integrations', () => {
  throw bindingWriteMoved('POST /api/projects/:projectId/integrations');
});

integrationsRoutes.patch(
  '/:projectId/integrations/:id',
  zValidator('json', updateSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const projectId = c.req.param('projectId');
    const id = c.req.param('id');
    const userId = c.get('userId');
    const { binding, connection } = await projectBinding(projectId, id, userId, 'admin');

    const patch = c.req.valid('json');
    const moved = (['agentAccess', 'active', 'instructions'] as const).filter(
      (key) => patch[key] !== undefined,
    );
    if (moved.length > 0) {
      throw bindingWriteMoved(
        `${moved.map((k) => `\`${k}\``).join(', ')} on PATCH /api/projects/:projectId/integrations/:id`,
      );
    }

    let mergedConfig: Record<string, unknown> | undefined;
    if (patch.config) {
      const parsed = configSchemaForProvider(binding.provider).safeParse(patch.config);
      if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
      const tiers = splitProviderConfig(binding.provider, parsed.data as Record<string, unknown>);
      const bindingKeys = Object.keys(tiers.binding);
      if (bindingKeys.length > 0) {
        throw bindingWriteMoved(
          `config ${bindingKeys.map((k) => `\`${k}\``).join(', ')} on PATCH /api/projects/:projectId/integrations/:id`,
        );
      }
      if (Object.keys(tiers.connection).length > 0) {
        mergedConfig = withdrawNulls({
          ...((connection.config ?? {}) as object),
          ...tiers.connection,
        });
      }
    }

    // Connection-tier config and secrets of an ORG-owned credential are managed
    // at the org tier: a project admin alone must not rotate a credential the
    // org's projects share.
    if (
      connection.ownerType === 'org' &&
      (mergedConfig !== undefined || patch.secrets !== undefined)
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

    if (mergedConfig !== undefined || mergedSecrets !== undefined) {
      const connPatch: Parameters<typeof updateConnection>[1] = {};
      if (mergedConfig !== undefined) connPatch.config = mergedConfig;
      if (mergedSecrets !== undefined) connPatch.secrets = mergedSecrets;
      await updateConnection(connection.id, connPatch);
    }

    const refreshed = await findBindingWithConnectionById(id);
    if (!refreshed) throw notFound();
    broadcastIntegrationChanged(projectId, { bindingId: id, connectionId: connection.id });
    notifyConnectionChanged(binding.provider, connection.id);
    return c.json({ integration: summarizeBinding(refreshed) });
  },
);

integrationsRoutes.delete('/:projectId/integrations/:id', () => {
  throw bindingWriteMoved('DELETE /api/projects/:projectId/integrations/:id');
});

integrationsRoutes.post('/:projectId/integrations/:id/test', async (c) => {
  const projectId = c.req.param('projectId');
  const id = c.req.param('id');
  const existing = await projectBinding(projectId, id, c.get('userId'));

  const adapter = adapterOrRefuse(existing.binding.provider);
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
  const existing = await projectBinding(projectId, id, c.get('userId'), 'admin');

  // The inbound HMAC secret is per-binding (an inbound webhook is project+env
  // scoped), so rotation targets the binding.
  const newSecret = `whsec_${randomBytes(24).toString('hex')}`;
  await setBindingInboundSecret(id, newSecret);
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
  const _existing = await projectBinding(projectId, id, c.get('userId'));

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
  const existing = await projectBinding(projectId, id, c.get('userId'), 'admin');

  const delivery = await findDeliveryById(deliveryId);
  if (!delivery || delivery.bindingId !== id) throw notFound('delivery');

  if (delivery.direction !== 'outbound' || delivery.status !== 'failed') {
    throw new HTTPException(409, {
      message: 'only failed outbound deliveries can be retried',
      cause: { code: 'NOT_RETRYABLE' },
    });
  }
  if (!adapterOrRefuse(existing.binding.provider).dispatchOutbound) {
    throw new HTTPException(409, {
      message: `${existing.binding.provider} dispatches nothing outbound, so delivery ${deliveryId} (\`${delivery.eventName}\`) cannot be re-sent; a merge is asked again on POST /api/issues/:id/merge-pull-request`,
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

// MCP preview (ISS-429, ISS-1191) — every server a project-wide agent session receives, composed
// in mcp-preview-service.ts from resolveSessionMcpServers, so nothing here resolves a second time.
integrationsRoutes.get('/:projectId/integrations/mcp-preview', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  return c.json(await buildMcpPreview(projectId));
});
