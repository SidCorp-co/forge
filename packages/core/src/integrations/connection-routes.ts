/**
 * Owner-scoped connection CRUD.
 *
 * A connection is the credential, owned by a principal (a user today). Bindings
 * (project-scoped, `routes.ts`) reference a connection. Mounted at a distinct
 * base so the single-segment paths never collide with the project router's
 * `/:id`.
 */

import { randomBytes } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { loadOrgRole, orgRoleAtLeast } from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { raceWithTimeout } from './probe.js';
import {
  applySecretsPatch,
  configSchemaForProvider,
  connectionCreateSchema,
  connectionUpdateSchema,
  environmentSchema,
  splitProviderConfig,
} from './provider-schemas.js';
import { getAdapter } from './registry.js';
import {
  TEST_PROBE_TIMEOUT_MS,
  alreadyExists,
  assertAdmin,
  assertNoActiveBindingClash,
  assertProjectMember,
  assertVaultConfigured,
  badRequest,
  buildCreatedBindingResponse,
  forbidden,
  notFound,
  reloadRocketChatIfNeeded,
  summarizeBinding,
  summarizeConnection,
} from './route-helpers.js';
import {
  type IntegrationConnectionRow,
  buildContextFromBinding,
  createBinding,
  createConnection,
  findConnectionById,
  listBindingsForConnection,
  listConnectionsForPrincipalUser,
  softDeleteConnection,
  updateConnection,
} from './store.js';
import type { IntegrationProvider } from './types.js';

async function loadManageableConnection(
  id: string,
  userId: string,
): Promise<IntegrationConnectionRow> {
  const connection = await findConnectionById(id);
  if (!connection) throw notFound('connection');
  if (connection.ownerType === 'user') {
    // Treat a connection owned by someone else as not-found (don't leak existence).
    if (connection.ownerId !== userId) throw notFound('connection');
    return connection;
  }
  // Org-owned: managing (update/rotate/delete/bind) requires org admin; a
  // plain org member sees it in lists but reads a truthful 403 here, and a
  // non-member reads not-found.
  const orgRole = await loadOrgRole(connection.ownerId, userId);
  if (!orgRole) throw notFound('connection');
  if (!orgRoleAtLeast(orgRole, 'admin')) throw forbidden();
  return connection;
}

export const integrationConnectionsRoutes = new Hono<{ Variables: AuthVars }>();
integrationConnectionsRoutes.use('*', requireAuth(), assertEmailVerified());

integrationConnectionsRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const rows = await listConnectionsForPrincipalUser(userId);
  return c.json({ items: rows.map(summarizeConnection) });
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
      displayName: body.displayName ?? null,
      config: body.config,
      secrets: body.secrets,
    });
    reloadRocketChatIfNeeded(body.provider, connection.id);
    return c.json({ connection: summarizeConnection(connection) }, 201);
  },
);

// Bind an EXISTING connection to a project+env — no secrets (the connection
// already holds the credential). Owner-only on the connection + admin on the
// TARGET project. Contrast the create path (POST /:projectId/integrations) which
// always mints a NEW connection from the request body's secrets.
const bindExistingSchema = z.object({
  projectId: z.string().min(1),
  environment: environmentSchema,
  // Binding-tier overrides (coolify resourceUuid/branch) so a shared connection
  // can target a different Coolify resource per project. Connection-tier keys
  // are validated then dropped — a bind must not shadow the shared baseUrl.
  config: z.record(z.string(), z.unknown()).optional(),
});

integrationConnectionsRoutes.post(
  '/:id/bindings',
  zValidator('json', bindExistingSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    // user-owned: owner-only; org-owned: org admin (not-found for outsiders).
    const connection = await loadManageableConnection(id, userId);
    const body = c.req.valid('json');
    // Admin on the target project (mirrors the create path's authorization).
    const role = await assertProjectMember(body.projectId, userId);
    assertAdmin(role);
    // An org-owned connection is shareable only within its own org.
    if (connection.ownerType === 'org') {
      const [targetProject] = await db
        .select({ orgId: projects.orgId })
        .from(projects)
        .where(eq(projects.id, body.projectId))
        .limit(1);
      if (!targetProject || targetProject.orgId !== connection.ownerId) {
        throw new HTTPException(409, {
          message: 'org connection can only bind to projects in its own org',
          cause: { code: 'ORG_MISMATCH' },
        });
      }
    }

    const provider = connection.provider as IntegrationProvider;
    // One active binding per (project, provider, env).
    await assertNoActiveBindingClash(body.projectId, provider, body.environment);

    // Optional per-project deploy-target overrides, validated against the
    // provider's partial schema then reduced to binding-tier keys only.
    let bindingConfig: Record<string, unknown> = {};
    if (body.config) {
      const parsed = configSchemaForProvider(provider).safeParse(body.config);
      if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
      bindingConfig = splitProviderConfig(provider, parsed.data as Record<string, unknown>).binding;
    }

    // Auto-mint a per-binding HMAC secret for inbound webhook verification.
    const integrationSecret = `whsec_${randomBytes(24).toString('hex')}`;
    let binding: Awaited<ReturnType<typeof createBinding>>;
    try {
      binding = await createBinding({
        connectionId: id,
        projectId: body.projectId,
        provider,
        environment: body.environment,
        config: bindingConfig,
        integrationSecret,
      });
    } catch (err) {
      // No connection rollback here — we did not create one (contrast the create
      // path, which soft-deletes its just-minted connection on a binding clash).
      if (isUniqueViolation(err)) throw alreadyExists();
      throw err;
    }
    reloadRocketChatIfNeeded(provider, id);
    // Re-probe on bind so the target project starts from current health rather
    // than whatever the connection last recorded (ISS-429).
    return c.json(
      await buildCreatedBindingResponse({ binding, connection }, integrationSecret),
      201,
    );
  },
);

integrationConnectionsRoutes.get('/:id/bindings', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  await loadManageableConnection(id, userId);
  const pairs = await listBindingsForConnection(id);
  return c.json({ items: pairs.map(summarizeBinding) });
});

// ISS-435 — connection-scoped healthcheck for the workspace directory drawer.
// Health lives on the connection, but an AdapterContext needs a binding
// (project/env/inbound-HMAC scope), so probe through a representative ACTIVE
// binding — oldest first, the same deterministic pick the health sweep and the
// MCP resolvers use. The adapter persists the result onto the connection
// itself, so every bound project's card reflects it on the next read.
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
      const parsed = configSchemaForProvider(existing.provider).safeParse(patch.config);
      if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
      connPatch.config = {
        ...((existing.config ?? {}) as object),
        ...(parsed.data as Record<string, unknown>),
      };
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
    reloadRocketChatIfNeeded(existing.provider, id);
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
  reloadRocketChatIfNeeded(existing.provider, id);
  return c.json({ ok: true });
});
