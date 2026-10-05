/**
 * Project-scoped integrations router (`/api/projects/:projectId/integrations`).
 *
 * Split for size (behavior-preserving): per-provider schemas + dispatch tables
 * in `provider-schemas.ts`; shared guards/projections in `route-helpers.ts`;
 * the status aggregation in `status-service.ts`; the MCP server preview in
 * `mcp-preview-service.ts`; the owner-scoped connection router in
 * `connection-routes.ts` (re-exported below for `src/index.ts`).
 */

import type { IntegrationRefusalCode } from '@forge/contracts/integrations';
import { Hono } from 'hono';
import { z } from 'zod';
import { adapterOrRefuse, applySecretsPatch, type BindingWithConnection, bindingWriteMoved, buildContextFromBinding, configSchemaForProvider, findBindingWithConnectionById, getAdapter, listBindingDeliveries, listBindingsForConnection, listBindingsForProject, mintInboundSecret, notFound, notifyConnectionChanged, rotateHeldInboundSecret, splitProviderConfig, summarizeBinding, updateConnection, updateSchema, withdrawNulls } from '../integrations/index.js';
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

integrationsRoutes.patch(
  '/:projectId/integrations/:id',
  zValidator('json', updateSchema),
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
  zValidator('json', rocketchatRoomsSchema),
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

  // A provider-held secret is the connection's, so every binding of it takes the new one and the
  // old keeps verifying until the first delivery signed with the new. A minted one is this binding's.
  const held = await rotateHeldInboundSecret(existing.connection.id);
  const newSecret = held ?? mintInboundSecret();
  const bindings = held ? await listBindingsForConnection(existing.connection.id) : [existing];
  for (const { binding } of bindings) {
    await setBindingInboundSecret(binding.id, newSecret);
    await announceIntegrationChanged(binding.projectId, {
      bindingId: binding.id,
      connectionId: existing.connection.id,
    });
  }
  const refreshed = await findBindingWithConnectionById(id);
  if (!refreshed) throw notFound();
  return c.json({
    integration: summarizeBinding(refreshed),
    integrationSecret: newSecret,
    pasteInto: getAdapter(existing.binding.provider)?.inboundSecretHome ?? null,
  });
});

integrationsRoutes.get('/:projectId/integrations/:id/deliveries', async (c) => {
  const projectId = c.req.param('projectId');
  const id = c.req.param('id');
  await projectBinding(projectId, id, c.get('userId'));
  return c.json({ items: await listBindingDeliveries(id) });
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

export { deviceGitCredentialRoutes } from './git-credential-routes.js';
export { githubCallbackRoutes, githubConnectRoutes } from './github-connect-routes.js';
export { issueMergePullRequestRoutes } from './issue-merge-routes.js';
export { webhookInboundRoutes } from './webhook-inbound-routes.js';
