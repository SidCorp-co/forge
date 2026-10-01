import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadOrgRole, orgRoleAtLeast } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { raceWithTimeout } from './probe.js';
import {
  applySecretsPatch,
  connectionConfigSchemaForProvider,
  connectionCreateSchema,
  connectionUpdateSchema,
} from './provider-schemas.js';
import { getAdapter } from './registry.js';
import { withdrawNulls } from './release-channel-schema.js';
import {
  assertVaultConfigured,
  badRequest,
  bindingWriteMoved,
  defaultConnectionDisplayName,
  forbidden,
  notFound,
  notifyConnectionChanged,
  summarizeBinding,
  summarizeConnection,
  summarizeConnectionWithUsage,
  TEST_PROBE_TIMEOUT_MS,
} from './route-helpers.js';
import {
  buildContextFromBinding,
  createConnection,
  findConnectionById,
  type IntegrationConnectionRow,
  listBindingsByConnectionIds,
  listBindingsForConnection,
  listConnectionsForPrincipalUser,
  softDeleteConnection,
  updateConnection,
} from './store.js';

async function loadManageableConnection(
  id: string,
  userId: string,
): Promise<IntegrationConnectionRow> {
  const connection = await findConnectionById(id);
  if (!connection) throw notFound('connection');
  if (connection.ownerType === 'user') {
    if (connection.ownerId !== userId) throw notFound('connection');
    return connection;
  }
  const orgRole = await loadOrgRole(connection.ownerId, userId);
  if (!orgRole) throw notFound('connection');
  if (!orgRoleAtLeast(orgRole, 'admin')) throw forbidden();
  return connection;
}

/**
 * Reading a connection, as opposed to managing it. Every principal the list
 * route shows a connection to can also read it here; only WRITING is gated on
 * org admin.
 */
async function loadVisibleConnection(
  id: string,
  userId: string,
): Promise<IntegrationConnectionRow> {
  const connection = await findConnectionById(id);
  if (!connection) throw notFound('connection');
  if (connection.ownerType === 'user') {
    if (connection.ownerId !== userId) throw notFound('connection');
    return connection;
  }
  const orgRole = await loadOrgRole(connection.ownerId, userId);
  if (!orgRole) throw notFound('connection');
  return connection;
}

export const integrationConnectionsRoutes = new Hono<{ Variables: AuthVars }>();
integrationConnectionsRoutes.use('*', requireAuth(), assertEmailVerified());

integrationConnectionsRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const rows = await listConnectionsForPrincipalUser(userId);
  const bindings = await listBindingsByConnectionIds(rows.map((r) => r.id));
  return c.json({
    items: rows.map((r) => summarizeConnectionWithUsage(r, bindings.get(r.id) ?? [])),
  });
});

integrationConnectionsRoutes.post(
  '/',
  zValidator('json', connectionCreateSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    assertVaultConfigured();
    const body = c.req.valid('json');
    // orgId present = an org-owned connection (shared across the org's
    // projects); requires org admin. Absent = personal (user-owned).
    if (body.orgId) {
      const orgRole = await loadOrgRole(body.orgId, userId);
      if (!orgRole) throw notFound('org');
      if (!orgRoleAtLeast(orgRole, 'admin')) throw forbidden();
    }
    const connection = await createConnection({
      ownerType: body.orgId ? 'org' : 'user',
      ownerId: body.orgId ?? userId,
      provider: body.provider,
      displayName:
        body.displayName ?? defaultConnectionDisplayName(body.provider, body.config ?? {}),
      config: body.config,
      secrets: body.secrets,
    });
    notifyConnectionChanged(body.provider, connection.id);
    return c.json({ connection: summarizeConnection(connection) }, 201);
  },
);

integrationConnectionsRoutes.post('/:id/bindings', () => {
  throw bindingWriteMoved('POST /api/integration-connections/:id/bindings');
});

integrationConnectionsRoutes.get('/:id/bindings', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  await loadVisibleConnection(id, userId);
  const pairs = await listBindingsForConnection(id);
  const bindings = pairs.map(summarizeBinding);
  return c.json({ bindings, items: bindings });
});

integrationConnectionsRoutes.post('/:id/test', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  await loadManageableConnection(id, userId);

  // listBindingsForConnection is newest-first; walk from the back for the
  // oldest active binding (health-sweep / resolver ordering).
  const pairs = await listBindingsForConnection(id);
  const pair = [...pairs].reverse().find((p) => p.binding.active);
  if (!pair) {
    throw new HTTPException(404, {
      message: 'connection has no active binding to probe through — share it with a project first',
      cause: { code: 'NO_BINDING' },
    });
  }

  const adapter = getAdapter(pair.binding.provider);
  if (!adapter) {
    throw new HTTPException(400, {
      message: `no adapter registered for provider=${pair.binding.provider}`,
      cause: { code: 'NO_ADAPTER' },
    });
  }
  // Time-boxed like the health sweep — a blackholed provider must not pin the
  // HTTP request open indefinitely. A timeout is reported as a truthful error
  // result, not a 5xx (the adapter keeps running and persists its own outcome).
  const result = await raceWithTimeout(
    adapter.healthcheck(buildContextFromBinding(pair)),
    TEST_PROBE_TIMEOUT_MS,
  );
  if (result === null) {
    return c.json({ status: 'error', message: 'healthcheck timed out after 10s' });
  }
  return c.json(result);
});

integrationConnectionsRoutes.patch(
  '/:id',
  zValidator('json', connectionUpdateSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const existing = await loadManageableConnection(id, userId);
    const patch = c.req.valid('json');

    const connPatch: Parameters<typeof updateConnection>[1] = {};
    if (patch.displayName !== undefined) connPatch.displayName = patch.displayName;
    if (patch.active !== undefined) connPatch.active = patch.active;
    if (patch.config) {
      const parsed = connectionConfigSchemaForProvider(existing.provider).safeParse(patch.config);
      if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
      // `withdrawNulls` as the binding PATCH does: a key sent as null is REMOVED. Storing one
      // left a withdrawn `releaseRunnerLabel` on the row as a null forever (ISS-1127, ISS-1275).
      connPatch.config = withdrawNulls({
        ...((existing.config ?? {}) as object),
        ...(parsed.data as Record<string, unknown>),
      });
    }
    if (patch.secrets) {
      const merged = await applySecretsPatch({
        provider: existing.provider,
        rawSecrets: patch.secrets,
        secretsEnc: existing.secretsEnc,
        // Historical order on this path: vault guard fires before the parse.
        vaultGuardTiming: 'before-parse',
      });
      if (merged !== undefined) connPatch.secrets = merged;
    }

    const updated = await updateConnection(id, connPatch);
    if (!updated) throw notFound('connection');
    notifyConnectionChanged(existing.provider, id);
    return c.json({ connection: summarizeConnection(updated) });
  },
);

integrationConnectionsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  const existing = await loadManageableConnection(id, userId);
  // Cascade: bindings reference the connection with ON DELETE CASCADE, but we
  // only soft-delete here (active=false) so existing bindings stop resolving via
  // findActiveBinding's `connection.active` filter without dropping audit rows.
  await softDeleteConnection(id);
  notifyConnectionChanged(existing.provider, id);
  return c.json({ ok: true });
});
