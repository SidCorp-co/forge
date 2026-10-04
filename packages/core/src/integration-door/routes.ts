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
import type { IntegrationRefusalCode } from '@forge/contracts/integrations';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  adapterOrRefuse,
  applySecretsPatch,
  type BindingWithConnection,
  bindingWriteMoved,
  buildContextFromBinding,
  configSchemaForProvider,
  enqueueOutboundDispatch,
  findBindingWithConnectionById,
  findDeliveryById,
  listBindingDeliveries,
  listBindingsForProject,
  notFound,
  notifyConnectionChanged,
  splitProviderConfig,
  summarizeBinding,
  updateConnection,
  updateSchema,
  withdrawNulls,
} from '../integrations/index.js';
import { fetchBotRooms, rocketChatBindingOfProject } from '../integrations/rocketchat/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { refuser } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan, requireOrgHeld } from '../permissions/index.js';
import { announceIntegrationChanged, setBindingInboundSecret } from '../project-config/index.js';
import { registerCoolifyDeployRoutes } from './coolify-routes.js';
import { buildMcpPreview } from './mcp-preview-service.js';
import { buildIntegrationsStatusCards } from './status-service.js';

const refuse = refuser<IntegrationRefusalCode>('INTEGRATION_REFUSED');

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
  await requireCan(
    actorFor(userId),
    need === 'admin' ? 'project.admin' : 'project.read',
    projectResource(projectId),
  );
  const existing = await findBindingWithConnectionById(id);
  if (!existing || existing.binding.projectId !== projectId) throw notFound();
  return existing;
}

integrationsRoutes.get('/:projectId/integrations', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  await requireCan(actorFor(userId), 'project.read', projectResource(projectId));

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
    if (!result.success) throw badRequest(result.error);
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
      if (!parsed.success) throw badRequest(parsed.error);
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
      const access = await loadProjectAccess(projectId, userId);
      requireOrgHeld(access.orgId, access.orgRole, 'org.admin');
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
    await announceIntegrationChanged(projectId, { bindingId: id, connectionId: connection.id });
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
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const projectId = c.req.param('projectId');
    const userId = c.get('userId');
    await requireCan(actorFor(userId), 'project.read', projectResource(projectId));
    const body = c.req.valid('json');

    let auth: { serverUrl: string; authToken: string; userId: string };
    if (body.integrationId) {
      const existing = await rocketChatBindingOfProject(projectId, body.integrationId);
      if (!existing) throw notFound();
      const ctx = buildContextFromBinding(existing);
      const cfg = ctx.config as { serverUrl?: string } | null;
      const secrets = ctx.secrets as { authToken?: string; userId?: string } | null;
      if (!cfg?.serverUrl || !secrets?.authToken || !secrets?.userId) {
        throw refuse(
          'MISSING_CREDENTIALS',
          'this rocketchat connection holds no serverUrl or no credentials; complete the connection first',
          '/integrationId',
        );
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
  await announceIntegrationChanged(projectId, {
    bindingId: id,
    connectionId: existing.connection.id,
  });
  return c.json({ integration: summarizeBinding(refreshed), integrationSecret: newSecret });
});

integrationsRoutes.get('/:projectId/integrations/:id/deliveries', async (c) => {
  const projectId = c.req.param('projectId');
  const id = c.req.param('id');
  const _existing = await projectBinding(projectId, id, c.get('userId'));

  const rows = await listBindingDeliveries(id);
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
    throw refuse(
      'NOT_RETRYABLE',
      `delivery ${deliveryId} is ${delivery.direction} and ${delivery.status}; only a failed outbound delivery is retried`,
    );
  }
  if (!adapterOrRefuse(existing.binding.provider).dispatchOutbound) {
    throw refuse(
      'NOT_RETRYABLE',
      `${existing.binding.provider} dispatches nothing outbound, so delivery ${deliveryId} (\`${delivery.eventName}\`) cannot be re-sent; a merge is asked again on POST /api/issues/:id/merge-pull-request`,
    );
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
  await requireCan(actorFor(userId), 'project.read', projectResource(projectId));

  return c.json({ cards: await buildIntegrationsStatusCards(projectId) });
});

// MCP preview (ISS-429, ISS-1191) — every server a project-wide agent session receives, composed
// in mcp-preview-service.ts from resolveSessionMcpServers, so nothing here resolves a second time.
integrationsRoutes.get('/:projectId/integrations/mcp-preview', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  await requireCan(actorFor(userId), 'project.read', projectResource(projectId));

  return c.json(await buildMcpPreview(projectId));
});

export { githubCallbackRoutes, githubConnectRoutes } from './github-connect-routes.js';
export { issueMergePullRequestRoutes } from './issue-merge-routes.js';
