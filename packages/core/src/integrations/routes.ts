import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  type IntegrationEnvironment,
  devices,
  integrationDeliveries,
  integrationEnvironments,
  projectMembers,
  projects,
  runners,
} from '../db/schema.js';
import { classifyGitRemote } from '../git/provision-credential.js';
import { effectiveProjectRole, loadOrgRole, orgRoleAtLeast } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { findDeliveryById } from './deliveries.js';
import { buildEpodsystemMcpEntry } from './epodsystem/resolver.js';
import { buildPostmanMcpEntry } from './postman/resolver.js';
import { raceWithTimeout } from './probe.js';
import { enqueueCoolifyDispatch } from './queue.js';
import { getAdapter } from './registry.js';
import { type RotatingProvider, isRotatingProvider, mergeRotatedSecrets } from './rotation.js';
import {
  type BindingWithConnection,
  type IntegrationConnectionRow,
  buildContextFromBinding,
  createBinding,
  createConnection,
  effectiveConfig,
  findActiveBinding,
  findBindingWithConnectionById,
  findConnectionById,
  listActiveBindingsForProjectProvider,
  listBindingsForConnection,
  listBindingsForProject,
  listConnectionsForPrincipalUser,
  softDeleteBinding,
  softDeleteConnection,
  updateBinding,
  updateConnection,
} from './store.js';
import { type HealthCheckResult, type IntegrationProvider, capabilitiesFor } from './types.js';
import { isVaultConfigured } from './vault.js';

// `assertVaultBootSafety` lets core boot when the integration tables are empty,
// so the first create/update attempt is the moment the missing-key
// misconfiguration surfaces. Convert it into a structured 503 so operators see
// a remediation message instead of a bare "Internal Server Error".
function assertVaultConfigured(): void {
  if (!isVaultConfigured()) {
    throw new HTTPException(503, {
      message:
        'integration vault is not configured — set INTEGRATION_MASTER_KEY on the core server (openssl rand -base64 32) and restart',
      cause: { code: 'VAULT_NOT_CONFIGURED' },
    });
  }
}

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });
const forbidden = () =>
  new HTTPException(403, { message: 'forbidden', cause: { code: 'FORBIDDEN' } });
const notFound = (entity = 'integration') =>
  new HTTPException(404, { message: `${entity} not found`, cause: { code: 'NOT_FOUND' } });

async function assertProjectMember(
  projectId: string,
  userId: string,
): Promise<'admin' | 'member' | 'viewer'> {
  const access = await effectiveProjectRole(userId, projectId);
  if (!access) throw notFound('project');
  if (!access.role) throw forbidden();
  return access.role;
}

function assertAdmin(role: 'admin' | 'member' | 'viewer'): void {
  if (role !== 'admin') throw forbidden();
}

const environmentSchema = z.enum(integrationEnvironments);

const coolifyConfigSchema = z.object({
  baseUrl: z.string().url().max(500),
  resourceUuid: z.string().min(1).max(200),
  branch: z.string().min(1).max(200),
});

// Coolify's deploy target is BINDING-tier: two projects sharing one connection
// (org-shared credential) each deploy their own Coolify resource, so
// resourceUuid/branch live on binding.config (overlaid over connection.config
// at dispatch — binding wins). Everything else (baseUrl) stays connection-tier
// with the credential.
const COOLIFY_BINDING_CONFIG_KEYS = ['resourceUuid', 'branch'] as const;

/** Split a validated provider config into its connection-tier and binding-tier
 *  halves. Non-coolify providers have no binding-tier fields today. */
function splitProviderConfig(
  provider: string,
  config: Record<string, unknown>,
): { connection: Record<string, unknown>; binding: Record<string, unknown> } {
  if (provider !== 'coolify') return { connection: config, binding: {} };
  const connection: Record<string, unknown> = { ...config };
  const binding: Record<string, unknown> = {};
  for (const key of COOLIFY_BINDING_CONFIG_KEYS) {
    if (key in connection) {
      binding[key] = connection[key];
      delete connection[key];
    }
  }
  return { connection, binding };
}

const coolifySecretsSchema = z.object({
  apiToken: z.string().min(8).max(2000),
});

// ISS-336 — Postman provider. Config is the non-secret write-target; the
// API key (PMAK-...) is the only secret and is vault-encrypted like coolify's.
// `postmanConfigBase` carries NO defaults so `.partial()` is a true partial for
// PATCH (Zod's `.partial()` still EMITS a field's `.default()` when the key is
// absent, which would silently reset region/mode/workspaceName on a partial
// update). Defaults live only on the create schema below.
const postmanConfigBase = z.object({
  workspaceId: z.string().min(1).max(200).optional(),
  workspaceName: z.string().min(1).max(200),
  collectionId: z.string().min(1).max(200).optional(),
  region: z.enum(['us', 'eu']),
  mode: z.enum(['minimal', 'full']),
});

const postmanConfigSchema = postmanConfigBase.extend({
  workspaceName: postmanConfigBase.shape.workspaceName.default('Forge Integration'),
  region: postmanConfigBase.shape.region.default('us'),
  mode: postmanConfigBase.shape.mode.default('minimal'),
});

const postmanSecretsSchema = z.object({
  apiKey: z.string().min(8).max(2000),
});

// ISS-387 — Epodsystem provider. One store per project; staging↔theme draft,
// prod↔theme main. Config is the non-secret store context; the `crmk_` API key
// is the only secret and is vault-encrypted like coolify/postman. The endpoint
// is NOT user config — it is fixed platform config (EPODSYSTEM_ENDPOINT env).
// Store identity fields (slug/name/theme ids) are filled by the healthcheck, so
// every config field is optional on input — the operator only supplies the key.
const epodsystemConfigBase = z.object({
  storeSlug: z.string().min(1).max(200).optional(),
  storeName: z.string().min(1).max(200).optional(),
  themeId: z.string().min(1).max(200).optional(),
  draftThemeId: z.string().min(1).max(200).optional(),
  commerceEnabled: z.boolean().optional(),
});

const epodsystemSecretsSchema = z.object({
  apiKey: z.string().min(8).max(2000),
});

// Discriminated on `provider` so each provider validates its own config +
// secrets shape. `environment` defaults to 'prod' for postman (it has no
// staging/prod split, but the binding column + unique index require a value).
const createSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('coolify'),
    environment: environmentSchema,
    config: coolifyConfigSchema,
    secrets: coolifySecretsSchema,
    // Present = mint the credential as ORG-owned (shared across the org's
    // projects); must equal the project's own org and the caller must be an
    // org admin. Absent = personal (user-owned), the historical default.
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('postman'),
    environment: environmentSchema.default('prod'),
    config: postmanConfigSchema,
    secrets: postmanSecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('epodsystem'),
    environment: environmentSchema.default('prod'),
    config: epodsystemConfigBase,
    secrets: epodsystemSecretsSchema,
    orgId: z.uuid().optional(),
  }),
]);

// PATCH carries no provider, so config/secrets are validated loosely here and
// re-validated against the EXISTING binding's provider inside the handler.
const updateSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
});

/** Per-provider partial config schema for PATCH validation. Uses the
 *  no-default base for postman so a partial patch never re-emits defaults. */
function configSchemaForProvider(provider: string): z.ZodTypeAny {
  if (provider === 'postman') return postmanConfigBase.partial();
  if (provider === 'epodsystem') return epodsystemConfigBase.partial();
  return coolifyConfigSchema.partial();
}

/**
 * Project-facing integration summary, projected from a binding + its owning
 * connection. Field names are kept stable for the web client: `id` is the
 * BINDING id (== old project_integration id for backfilled rows); health/breaker
 * + secret-presence come from the connection; `config` is the effective overlay.
 */
function summarizeBinding(pair: BindingWithConnection) {
  const { binding, connection } = pair;
  return {
    id: binding.id,
    connectionId: connection.id,
    projectId: binding.projectId,
    provider: binding.provider as IntegrationProvider,
    environment: binding.environment as IntegrationEnvironment,
    config: effectiveConfig(pair),
    // Raw binding-tier overrides so clients can tell a per-project value from
    // one inherited off the shared connection (`config` is the merged view).
    bindingConfig: (binding.config ?? {}) as Record<string, unknown>,
    active: binding.active && connection.active,
    lastHealthStatus: connection.lastHealthStatus,
    lastHealthAt: connection.lastHealthAt,
    breakerOpenedAt: connection.breakerOpenedAt,
    hasSecrets: connection.secretsEnc !== null,
    integrationSecretSet: binding.integrationSecret !== null,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

/** Owner-facing connection summary (never echoes secret bytes). */
function summarizeConnection(connection: IntegrationConnectionRow) {
  return {
    id: connection.id,
    ownerType: connection.ownerType,
    ownerId: connection.ownerId,
    provider: connection.provider as IntegrationProvider,
    displayName: connection.displayName,
    config: connection.config,
    active: connection.active,
    lastHealthStatus: connection.lastHealthStatus,
    lastHealthAt: connection.lastHealthAt,
    breakerOpenedAt: connection.breakerOpenedAt,
    hasSecrets: connection.secretsEnc !== null,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

/**
 * Broadcast a binding mutation to the project room so web clients refresh the
 * integrations list/status + connections cache live (ISS-401/C). Fire-and-
 * forget — never let a publish failure surface on the mutation response. Only
 * binding mutations carry a `projectId`; owner-scoped connection mutations have
 * no project room and rely on client self-invalidation + reconnect replay.
 */
function broadcastIntegrationChanged(
  projectId: string,
  extra: { bindingId?: string; connectionId?: string } = {},
): void {
  try {
    roomManager.publish(projectRoom(projectId), {
      event: 'integration.changed',
      data: { projectId, ...extra },
    });
  } catch {
    // Realtime is best-effort; window-focus refetch + reconnect replay backstop.
  }
}

/** The create/bind 201 must not hang on a slow provider — past this the
 *  response returns `health: null` and the probe result lands via the
 *  adapter's own write + the next refetch (ISS-431). */
const INITIAL_PROBE_TIMEOUT_MS = 5_000;

/** Cap for the explicit connection Test (ISS-435) — matches the health
 *  sweep's per-probe budget. */
const TEST_PROBE_TIMEOUT_MS = 10_000;

/**
 * Best-effort immediate healthcheck after a binding is created or bound
 * (ISS-429): the operator gets a REAL health state right away instead of an
 * `unverified` card until someone presses Test. Adapter healthchecks persist
 * health onto the connection (epodsystem additionally fills store identity
 * into config), so callers should re-read the pair afterwards. Never throws —
 * a failed probe is a valid result, and a crashed probe must not undo a
 * successful create. Time-boxed: the adapter keeps running past the deadline
 * (its result still persists), only the response stops waiting.
 */
async function runInitialHealthcheck(
  pair: BindingWithConnection,
): Promise<HealthCheckResult | null> {
  const adapter = getAdapter(pair.binding.provider);
  if (!adapter) return null;
  try {
    return await raceWithTimeout(
      adapter.healthcheck(buildContextFromBinding(pair)),
      INITIAL_PROBE_TIMEOUT_MS,
    );
  } catch {
    // The adapter records its own failure states; a transport-level crash here
    // simply leaves the connection `unverified`.
    return null;
  }
}

/**
 * Shared tail of the two binding-creating endpoints (create + bind-existing,
 * ISS-429/431): immediate probe, re-read for fresh health/config (the probe
 * mutates the connection), broadcast, and the 201 payload.
 */
async function buildCreatedBindingResponse(
  pair: BindingWithConnection,
  integrationSecret: string,
): Promise<{
  integration: ReturnType<typeof summarizeBinding>;
  integrationSecret: string;
  health: HealthCheckResult | null;
}> {
  const health = await runInitialHealthcheck(pair);
  let refreshed: BindingWithConnection | null | undefined;
  try {
    refreshed = await findBindingWithConnectionById(pair.binding.id);
  } catch {
    refreshed = null;
  }
  broadcastIntegrationChanged(pair.binding.projectId, {
    bindingId: pair.binding.id,
    connectionId: pair.connection.id,
  });
  return { integration: summarizeBinding(refreshed ?? pair), integrationSecret, health };
}

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

    // One active binding per (project, provider, env) — guard before we create a
    // connection so we don't leave an orphan when the binding would collide.
    const clash = await findActiveBinding(projectId, body.provider, body.environment);
    if (clash) {
      throw new HTTPException(409, {
        message: 'integration already exists for this provider+environment',
        cause: { code: 'ALREADY_EXISTS' },
      });
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
      });
    } catch (err) {
      // Roll the just-created connection back so a binding-unique collision
      // doesn't leave a dangling credential.
      await softDeleteConnection(connection.id).catch(() => {});
      const code = (err as { code?: string } | null)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === '23505' || /duplicate key|unique/.test(msg)) {
        throw new HTTPException(409, {
          message: 'integration already exists for this provider+environment',
          cause: { code: 'ALREADY_EXISTS' },
        });
      }
      throw err;
    }
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
      const tiers = splitProviderConfig(
        binding.provider,
        parsed.data as Record<string, unknown>,
      );
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

    let mergedSecrets: Record<string, unknown> | null | undefined = undefined;
    // All providers route through the shared rotation helper so the dual-token
    // overlap window applies uniformly (ISS-405). Per-provider zod parsing
    // stays here so each provider's input shape is validated before the merge.
    if (patch.secrets && isRotatingProvider(binding.provider)) {
      const provider: RotatingProvider = binding.provider;
      let incoming: Record<string, unknown> | null = null;
      if (provider === 'coolify') {
        const parsed = coolifySecretsSchema.partial().safeParse(patch.secrets);
        if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
        incoming = parsed.data;
      } else {
        const parsed = postmanSecretsSchema.partial().safeParse(patch.secrets);
        if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
        incoming = parsed.data;
      }
      // Skip the vault guard for a config-only PATCH (no primary credential
      // change) — same conditional as the prior coolify branch.
      const primaryField = provider === 'coolify' ? 'apiToken' : 'apiKey';
      if (typeof incoming[primaryField] === 'string') {
        assertVaultConfigured();
        const currentSecrets = connection.secretsEnc
          ? (await import('./vault.js')).decryptJson<Record<string, unknown>>(connection.secretsEnc)
          : null;
        const merged = mergeRotatedSecrets(provider, currentSecrets, incoming);
        if (merged) mergedSecrets = merged;
      }
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

// === ISS-305 — composed read-only integrations status for the web hub ===
//
// Aggregates ONLY real, already-existing signals — no fabricated metrics. Each
// card carries a status the UI renders with icon + text (never color-only) plus
// a last-sync timestamp where one genuinely exists. Providers with no backing
// data render `not_configured` rather than inventing health. Each provider card
// also carries its adapter `capabilities` so the UI renders to the provider's
// archetype (e.g. no delivery-log affordance for MCP-injection providers).

const pExecFile = promisify(execFile);

type CardStatus =
  | 'connected'
  | 'attention'
  | 'error'
  | 'not_configured'
  | 'disabled'
  | 'unverified';

interface StatusCard {
  key: string;
  label: string;
  status: CardStatus;
  detail: string;
  lastSyncAt: string | null;
  configured: boolean;
  meta?: Record<string, unknown>;
}

/** Best-effort `git remote get-url origin` against a local checkout. */
async function readGitRemote(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await pExecFile('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      timeout: 3000,
      windowsHide: true,
    });
    const url = stdout.trim();
    return url || null;
  } catch {
    return null;
  }
}

function healthToStatus(lastHealthStatus: string | null, active: boolean): CardStatus {
  // The binding/connection exists but is switched off — distinct from
  // not_configured (nothing set up at all). ISS-429.
  if (!active) return 'disabled';
  // Active but never health-checked: no signal is not the same as degraded.
  if (!lastHealthStatus) return 'unverified';
  const s = lastHealthStatus.toLowerCase();
  if (s === 'ok' || s === 'healthy' || s === 'success') return 'connected';
  if (s === 'degraded' || s === 'pending' || s === 'unknown') return 'attention';
  // needs_reauth (ISS-409) is operator-actionable (re-enter the credential), so
  // it buckets to `attention`; F3 reads the raw lastHealthStatus for a re-auth chip.
  if (s === 'needs_reauth') return 'attention';
  return 'error';
}

function toIso(d: Date | string | null): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : d;
}

/** Adapter capabilities for a provider, for capability-aware card rendering. */
function providerCapabilities(provider: IntegrationProvider) {
  return capabilitiesFor(getAdapter(provider));
}

/** Flattened binding+connection row the status cards render from. */
interface ProviderRow {
  provider: string;
  environment: string;
  config: Record<string, unknown>;
  active: boolean;
  lastHealthStatus: string | null;
  lastHealthAt: Date | null;
  breakerOpenedAt: Date | null;
}

/**
 * Shared builder for the coolify/postman/epodsystem status cards (ISS-431) —
 * the three blocks were ~95% identical; they differ only in env-keying, the
 * never-checked wording, and provider-specific meta fields.
 */
function buildProviderCards(opts: {
  rows: ProviderRow[];
  provider: IntegrationProvider;
  label: string;
  /** Coolify is env-split by design, so even a single binding keys by env;
   *  MCP providers keep the bare key unless a second binding appears (keeps
   *  existing drill-ins stable, ISS-429). */
  alwaysEnvKeyed: boolean;
  neverCheckedDetail: string;
  extraMeta?: (row: ProviderRow) => Record<string, unknown>;
}): StatusCard[] {
  const caps = providerCapabilities(opts.provider);
  if (opts.rows.length === 0) {
    return [
      {
        key: opts.provider,
        label: opts.label,
        status: 'not_configured',
        detail: `no ${opts.label} integration configured`,
        lastSyncAt: null,
        configured: false,
        meta: { capabilities: caps },
      },
    ];
  }
  const envKeyed = opts.alwaysEnvKeyed || opts.rows.length > 1;
  return opts.rows.map((row) => ({
    key: envKeyed ? `${opts.provider}:${row.environment}` : opts.provider,
    label: envKeyed ? `${opts.label} (${row.environment})` : opts.label,
    status: healthToStatus(row.lastHealthStatus, row.active),
    detail: !row.active
      ? 'integration disabled'
      : row.lastHealthStatus
        ? `last health: ${row.lastHealthStatus}`
        : opts.neverCheckedDetail,
    lastSyncAt: toIso(row.lastHealthAt),
    configured: true,
    meta: {
      environment: row.environment,
      breakerOpen: row.breakerOpenedAt !== null,
      lastHealthStatus: row.lastHealthStatus,
      capabilities: caps,
      ...(opts.extraMeta?.(row) ?? {}),
    },
  }));
}

integrationsRoutes.get('/:projectId/integrations/status', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  const [project] = await db
    .select({ repoPath: projects.repoPath, baseBranch: projects.baseBranch })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw notFound('project');

  // One row per active binding, joined to its connection (health/breaker live on
  // the connection). Flattened to the shape the cards below already consume.
  const pairs = await listBindingsForProject(projectId);
  const integrationRows = pairs.map((pair) => ({
    provider: pair.binding.provider,
    environment: pair.binding.environment,
    config: effectiveConfig(pair),
    active: pair.binding.active && pair.connection.active,
    lastHealthStatus: pair.connection.lastHealthStatus,
    lastHealthAt: pair.connection.lastHealthAt,
    breakerOpenedAt: pair.connection.breakerOpenedAt,
  }));

  // Runners bound to this project + each device's git push-cred status.
  const runnerRows = await db
    .select({
      runnerId: runners.id,
      status: runners.status,
      deviceId: runners.deviceId,
      deviceName: devices.name,
      gitCredentialRef: devices.gitCredentialRef,
      lastSeenAt: runners.lastSeenAt,
    })
    .from(runners)
    .leftJoin(devices, eq(devices.id, runners.deviceId))
    .where(eq(runners.projectId, projectId));

  const cards: StatusCard[] = [];

  // --- GitHub (repo + per-device push-cred) ---
  const remoteUrl = project.repoPath ? await readGitRemote(project.repoPath) : null;
  const transport = classifyGitRemote(remoteUrl);
  const deviceCreds = runnerRows
    .filter((r) => r.deviceId)
    .map((r) => ({
      deviceId: r.deviceId,
      deviceName: r.deviceName,
      pushCredProvisioned: r.gitCredentialRef !== null,
    }));
  cards.push({
    key: 'github',
    label: 'GitHub',
    status: project.repoPath ? 'connected' : 'not_configured',
    detail: remoteUrl ?? project.repoPath ?? 'no repo configured',
    lastSyncAt: null,
    configured: Boolean(project.repoPath),
    meta: { transport, remoteUrl, baseBranch: project.baseBranch, deviceCreds },
  });

  // --- Provider cards: one card PER BINDING (ISS-429 — a disabled binding
  // must not shadow an active one), built by the shared builder (ISS-431).
  // Epodsystem meta carries only non-secret store identity — never the crmk_
  // key. ---
  cards.push(
    ...buildProviderCards({
      rows: integrationRows.filter((r) => r.provider === 'coolify'),
      provider: 'coolify',
      label: 'Coolify',
      alwaysEnvKeyed: true,
      neverCheckedDetail: 'never health-checked',
    }),
    ...buildProviderCards({
      rows: integrationRows.filter((r) => r.provider === 'postman'),
      provider: 'postman',
      label: 'Postman',
      alwaysEnvKeyed: false,
      neverCheckedDetail: 'never test-connected',
      extraMeta: (row) => {
        const cfg = (row.config ?? {}) as { region?: string; mode?: string };
        return { region: cfg.region ?? 'us', mode: cfg.mode ?? 'minimal' };
      },
    }),
    ...buildProviderCards({
      rows: integrationRows.filter((r) => r.provider === 'epodsystem'),
      provider: 'epodsystem',
      label: 'Epodsystem',
      alwaysEnvKeyed: false,
      neverCheckedDetail: 'never test-connected',
      extraMeta: (row) => {
        const cfg = (row.config ?? {}) as { storeSlug?: string; storeName?: string };
        return { storeSlug: cfg.storeSlug ?? null, storeName: cfg.storeName ?? null };
      },
    }),
  );

  // --- Runners / devices online ---
  const totalRunners = runnerRows.length;
  const onlineRunners = runnerRows.filter((r) => r.status === 'online').length;
  cards.push({
    key: 'runners',
    label: 'Runners',
    status: totalRunners === 0 ? 'not_configured' : onlineRunners > 0 ? 'connected' : 'attention',
    detail:
      totalRunners === 0
        ? 'no runners bound to this project'
        : `${onlineRunners}/${totalRunners} online`,
    lastSyncAt: null,
    configured: totalRunners > 0,
    meta: { online: onlineRunners, total: totalRunners },
  });

  // --- Postgres (the query above just succeeded → the DB is reachable) ---
  cards.push({
    key: 'postgres',
    label: 'Postgres',
    status: 'connected',
    detail: 'core database reachable',
    lastSyncAt: null,
    configured: true,
  });

  // --- Forge MCP server (mounted at /mcp on this core) ---
  cards.push({
    key: 'mcp',
    label: 'MCP server',
    status: 'connected',
    detail: 'Forge MCP server mounted at /mcp',
    lastSyncAt: null,
    configured: true,
  });

  // --- Sentry (server-side DSN presence only — no per-project quota API) ---
  const sentryConfigured = Boolean(process.env.SENTRY_DSN);
  cards.push({
    key: 'sentry',
    label: 'Sentry',
    status: sentryConfigured ? 'connected' : 'not_configured',
    detail: sentryConfigured ? 'error reporting enabled' : 'no SENTRY_DSN configured',
    lastSyncAt: null,
    configured: sentryConfigured,
  });

  // --- Claude (auth + quota are managed per-runner; no core-side backing data) ---
  cards.push({
    key: 'claude',
    label: 'Claude',
    status: 'not_configured',
    detail: 'auth + quota managed per-runner (no core-side metric)',
    lastSyncAt: null,
    configured: false,
  });

  return c.json({ cards });
});

// === MCP injection preview (ISS-429) ===

/** One MCP-injection provider entry in the preview (mirrors contracts type). */
interface McpServerPreviewEntry {
  provider: IntegrationProvider;
  serverName: string;
  /** Binding id backing this entry — null for the synthetic not_configured row. */
  bindingId: string | null;
  environment: IntegrationEnvironment | null;
  configured: boolean;
  active: boolean;
  willInject: boolean;
  reason: 'ok' | 'not_configured' | 'disabled' | 'no_credential' | 'shadowed';
  url: string | null;
  headers: Record<string, string> | null;
  lastHealthStatus: string | null;
  lastHealthAt: string | null;
}

/** The providers whose adapters inject an mcpServers entry at dispatch time. */
const MCP_PROVIDERS = ['postman', 'epodsystem'] as const;

function buildMcpEntryFor(
  provider: (typeof MCP_PROVIDERS)[number],
  pair: BindingWithConnection,
): Record<string, unknown> {
  // Same builders the dispatch resolvers use — the URL can't drift from what a
  // runner actually receives. The key argument is a placeholder; the headers
  // are replaced wholesale below so secret bytes never reach the response.
  return provider === 'postman'
    ? buildPostmanMcpEntry(effectiveConfig(pair), '')
    : buildEpodsystemMcpEntry(effectiveConfig(pair), '');
}

/**
 * Render exactly what the dispatch-time resolvers will inject into a runner's
 * `mcpServers` for this project — same builders, same active/secret filters,
 * same first-active-binding pick — so the UI can show a truthful "these MCP
 * servers reach your agents" panel without fabricating URLs client-side.
 * `Authorization` is redacted BY CONSTRUCTION (the real key is never built
 * into the preview entry).
 */
integrationsRoutes.get('/:projectId/integrations/mcp-preview', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  const pairs = await listBindingsForProject(projectId);
  const servers: McpServerPreviewEntry[] = [];

  for (const provider of MCP_PROVIDERS) {
    const rows = pairs.filter((p) => p.binding.provider === provider);
    if (rows.length === 0) {
      servers.push({
        provider,
        serverName: provider,
        bindingId: null,
        environment: null,
        configured: false,
        active: false,
        willInject: false,
        reason: 'not_configured',
        url: null,
        headers: null,
        lastHealthStatus: null,
        lastHealthAt: null,
      });
      continue;
    }

    // The resolver injects ONE entry per provider key — the first row of the
    // same active-bindings query. Resolve that pick here so a multi-binding
    // project sees which binding actually wins (`shadowed` marks the losers).
    const [resolverPick] = await listActiveBindingsForProjectProvider(projectId, provider);

    for (const pair of rows) {
      const active = pair.binding.active && pair.connection.active;
      const hasSecrets = pair.connection.secretsEnc !== null;
      const isPick = resolverPick?.binding.id === pair.binding.id;
      const willInject = active && hasSecrets && isPick;
      const entry = buildMcpEntryFor(provider, pair);
      servers.push({
        provider,
        serverName: provider,
        bindingId: pair.binding.id,
        environment: pair.binding.environment as IntegrationEnvironment,
        configured: true,
        active,
        willInject,
        reason: willInject
          ? 'ok'
          : !active
            ? 'disabled'
            : !hasSecrets
              ? 'no_credential'
              : 'shadowed',
        url: typeof entry.url === 'string' ? entry.url : null,
        headers: willInject ? { Authorization: 'Bearer [redacted]' } : null,
        lastHealthStatus: pair.connection.lastHealthStatus,
        lastHealthAt: toIso(pair.connection.lastHealthAt),
      });
    }
  }

  return c.json({ servers });
});

// === Owner-scoped connection CRUD ===
//
// A connection is the credential, owned by a principal (a user today). Bindings
// (project-scoped, above) reference a connection. Mounted at a distinct base so
// the single-segment paths never collide with the project router's `/:id`.

const connectionCreateSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('coolify'),
    displayName: z.string().min(1).max(200).optional(),
    config: coolifyConfigSchema,
    secrets: coolifySecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('postman'),
    displayName: z.string().min(1).max(200).optional(),
    config: postmanConfigSchema,
    secrets: postmanSecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('epodsystem'),
    displayName: z.string().min(1).max(200).optional(),
    config: epodsystemConfigBase,
    secrets: epodsystemSecretsSchema,
    orgId: z.uuid().optional(),
  }),
]);

const connectionUpdateSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
});

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
    const clash = await findActiveBinding(body.projectId, provider, body.environment);
    if (clash) {
      throw new HTTPException(409, {
        message: 'integration already exists for this provider+environment',
        cause: { code: 'ALREADY_EXISTS' },
      });
    }

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
      const code = (err as { code?: string } | null)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === '23505' || /duplicate key|unique/.test(msg)) {
        throw new HTTPException(409, {
          message: 'integration already exists for this provider+environment',
          cause: { code: 'ALREADY_EXISTS' },
        });
      }
      throw err;
    }
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
    if (patch.secrets && isRotatingProvider(existing.provider)) {
      assertVaultConfigured();
      const provider: RotatingProvider = existing.provider;
      let incoming: Record<string, unknown> | null = null;
      if (provider === 'coolify') {
        const parsed = coolifySecretsSchema.partial().safeParse(patch.secrets);
        if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
        incoming = parsed.data;
      } else {
        const parsed = postmanSecretsSchema.partial().safeParse(patch.secrets);
        if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
        incoming = parsed.data;
      }
      const primaryField = provider === 'coolify' ? 'apiToken' : 'apiKey';
      if (typeof incoming[primaryField] === 'string') {
        const currentSecrets = existing.secretsEnc
          ? (await import('./vault.js')).decryptJson<Record<string, unknown>>(existing.secretsEnc)
          : null;
        const merged = mergeRotatedSecrets(provider, currentSecrets, incoming);
        if (merged) connPatch.secrets = merged;
      }
    }

    const updated = await updateConnection(id, connPatch);
    if (!updated) throw notFound('connection');
    return c.json({ connection: summarizeConnection(updated) });
  },
);

integrationConnectionsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  await loadManageableConnection(id, userId);
  // Cascade: bindings reference the connection with ON DELETE CASCADE, but we
  // only soft-delete here (active=false) so existing bindings stop resolving via
  // findActiveBinding's `connection.active` filter without dropping audit rows.
  await softDeleteConnection(id);
  return c.json({ ok: true });
});
