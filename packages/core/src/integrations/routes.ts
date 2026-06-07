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
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
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
  listBindingsForProject,
  listConnectionsForOwner,
  softDeleteBinding,
  softDeleteConnection,
  updateBinding,
  updateConnection,
} from './store.js';
import { type IntegrationProvider, capabilitiesFor } from './types.js';
import { isVaultConfigured } from './vault.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

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
): Promise<'owner' | 'admin' | 'member'> {
  const [project] = await db
    .select({ id: projects.id, ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw notFound('project');
  if (project.ownerId === userId) return 'owner';
  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  if (!member) throw forbidden();
  return member.role;
}

function assertAdmin(role: 'owner' | 'admin' | 'member'): void {
  if (role === 'member') throw forbidden();
}

const environmentSchema = z.enum(integrationEnvironments);

const coolifyConfigSchema = z.object({
  baseUrl: z.string().url().max(500),
  resourceUuid: z.string().min(1).max(200),
  branch: z.string().min(1).max(200),
});

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
  }),
  z.object({
    provider: z.literal('postman'),
    environment: environmentSchema.default('prod'),
    config: postmanConfigSchema,
    secrets: postmanSecretsSchema,
  }),
  z.object({
    provider: z.literal('epodsystem'),
    environment: environmentSchema.default('prod'),
    config: epodsystemConfigBase,
    secrets: epodsystemSecretsSchema,
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

    // Create the credential (connection, owned by the caller) then bind it into
    // this project+env. Config lives on the connection; the binding carries the
    // env + inbound HMAC. (Per-binding config overrides arrive with the shared-
    // connection UX in a later epic issue.)
    const connection = await createConnection({
      ownerId: userId,
      provider: body.provider,
      config: { ...body.config, environment: body.environment },
      secrets: body.secrets,
    });
    try {
      const binding = await createBinding({
        connectionId: connection.id,
        projectId,
        provider: body.provider,
        environment: body.environment,
        integrationSecret,
      });
      broadcastIntegrationChanged(projectId, { bindingId: binding.id, connectionId: connection.id });
      return c.json(
        { integration: summarizeBinding({ binding, connection }), integrationSecret },
        201,
      );
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
    // never strip the wrong provider's fields. Config lives on the connection.
    let mergedConfig: Record<string, unknown> | undefined;
    if (patch.config) {
      const parsed = configSchemaForProvider(binding.provider).safeParse(patch.config);
      if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
      mergedConfig = {
        ...((connection.config ?? {}) as object),
        ...(parsed.data as Record<string, unknown>),
      };
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

    // Config + secrets live on the connection; `active` toggles the binding
    // (disabling resolution for this project without touching the credential).
    if (mergedConfig !== undefined || mergedSecrets !== undefined) {
      const connPatch: Parameters<typeof updateConnection>[1] = {};
      if (mergedConfig !== undefined) connPatch.config = mergedConfig;
      if (mergedSecrets !== undefined) connPatch.secrets = mergedSecrets;
      await updateConnection(connection.id, connPatch);
    }
    if (patch.active !== undefined) {
      await updateBinding(binding.id, { active: patch.active });
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

// === ISS-305 — composed read-only integrations status for the web hub ===
//
// Aggregates ONLY real, already-existing signals — no fabricated metrics. Each
// card carries a status the UI renders with icon + text (never color-only) plus
// a last-sync timestamp where one genuinely exists. Providers with no backing
// data render `not_configured` rather than inventing health. Each provider card
// also carries its adapter `capabilities` so the UI renders to the provider's
// archetype (e.g. no delivery-log affordance for MCP-injection providers).

const pExecFile = promisify(execFile);

type CardStatus = 'connected' | 'attention' | 'error' | 'not_configured';

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

function coolifyHealthToStatus(lastHealthStatus: string | null, active: boolean): CardStatus {
  if (!active) return 'not_configured';
  if (!lastHealthStatus) return 'attention';
  const s = lastHealthStatus.toLowerCase();
  if (s === 'ok' || s === 'healthy' || s === 'success') return 'connected';
  if (s === 'degraded' || s === 'pending' || s === 'unknown') return 'attention';
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

  // --- Coolify (one card per configured binding) ---
  const coolifyRows = integrationRows.filter((r) => r.provider === 'coolify');
  const coolifyCaps = providerCapabilities('coolify');
  if (coolifyRows.length === 0) {
    cards.push({
      key: 'coolify',
      label: 'Coolify',
      status: 'not_configured',
      detail: 'no Coolify integration configured',
      lastSyncAt: null,
      configured: false,
      meta: { capabilities: coolifyCaps },
    });
  } else {
    for (const row of coolifyRows) {
      cards.push({
        key: `coolify:${row.environment}`,
        label: `Coolify (${row.environment})`,
        status: coolifyHealthToStatus(row.lastHealthStatus, row.active),
        detail: row.lastHealthStatus
          ? `last health: ${row.lastHealthStatus}`
          : 'never health-checked',
        lastSyncAt: toIso(row.lastHealthAt),
        configured: true,
        meta: {
          environment: row.environment,
          breakerOpen: row.breakerOpenedAt !== null,
          capabilities: coolifyCaps,
        },
      });
    }
  }

  // --- Postman (ISS-336) — one card; reflects the active binding's last
  // test-connection health, or 'not_configured' when absent. ---
  const postmanRow = integrationRows.find((r) => r.provider === 'postman');
  const postmanCaps = providerCapabilities('postman');
  if (!postmanRow) {
    cards.push({
      key: 'postman',
      label: 'Postman',
      status: 'not_configured',
      detail: 'no Postman integration configured',
      lastSyncAt: null,
      configured: false,
      meta: { capabilities: postmanCaps },
    });
  } else {
    const pmCfg = (postmanRow.config ?? {}) as { region?: string; mode?: string };
    cards.push({
      key: 'postman',
      label: 'Postman',
      status: coolifyHealthToStatus(postmanRow.lastHealthStatus, postmanRow.active),
      detail: !postmanRow.active
        ? 'integration disabled'
        : postmanRow.lastHealthStatus
          ? `last health: ${postmanRow.lastHealthStatus}`
          : 'never test-connected',
      lastSyncAt: toIso(postmanRow.lastHealthAt),
      configured: true,
      meta: { region: pmCfg.region ?? 'us', mode: pmCfg.mode ?? 'minimal', capabilities: postmanCaps },
    });
  }

  // --- Epodsystem (ISS-387) — one card; reflects the active binding's last
  // test-connection health, or 'not_configured' when absent. Carries only
  // non-secret store identity in meta — never the crmk_ key. ---
  const epodsystemRow = integrationRows.find((r) => r.provider === 'epodsystem');
  const epodsystemCaps = providerCapabilities('epodsystem');
  if (!epodsystemRow) {
    cards.push({
      key: 'epodsystem',
      label: 'Epodsystem',
      status: 'not_configured',
      detail: 'no Epodsystem integration configured',
      lastSyncAt: null,
      configured: false,
      meta: { capabilities: epodsystemCaps },
    });
  } else {
    const epCfg = (epodsystemRow.config ?? {}) as { storeSlug?: string; storeName?: string };
    cards.push({
      key: 'epodsystem',
      label: 'Epodsystem',
      status: coolifyHealthToStatus(epodsystemRow.lastHealthStatus, epodsystemRow.active),
      detail: !epodsystemRow.active
        ? 'integration disabled'
        : epodsystemRow.lastHealthStatus
          ? `last health: ${epodsystemRow.lastHealthStatus}`
          : 'never test-connected',
      lastSyncAt: toIso(epodsystemRow.lastHealthAt),
      configured: true,
      meta: {
        storeSlug: epCfg.storeSlug ?? null,
        storeName: epCfg.storeName ?? null,
        capabilities: epodsystemCaps,
      },
    });
  }

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
  }),
  z.object({
    provider: z.literal('postman'),
    displayName: z.string().min(1).max(200).optional(),
    config: postmanConfigSchema,
    secrets: postmanSecretsSchema,
  }),
  z.object({
    provider: z.literal('epodsystem'),
    displayName: z.string().min(1).max(200).optional(),
    config: epodsystemConfigBase,
    secrets: epodsystemSecretsSchema,
  }),
]);

const connectionUpdateSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
});

async function loadOwnedConnection(
  id: string,
  userId: string,
): Promise<IntegrationConnectionRow> {
  const connection = await findConnectionById(id);
  // Treat a connection owned by someone else as not-found (don't leak existence).
  if (!connection || connection.ownerType !== 'user' || connection.ownerId !== userId) {
    throw notFound('connection');
  }
  return connection;
}

export const integrationConnectionsRoutes = new Hono<{ Variables: AuthVars }>();
integrationConnectionsRoutes.use('*', requireAuth(), assertEmailVerified());

integrationConnectionsRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const rows = await listConnectionsForOwner(userId);
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
    const connection = await createConnection({
      ownerType: 'user',
      ownerId: userId,
      provider: body.provider,
      displayName: body.displayName ?? null,
      config: body.config,
      secrets: body.secrets,
    });
    return c.json({ connection: summarizeConnection(connection) }, 201);
  },
);

integrationConnectionsRoutes.patch(
  '/:id',
  zValidator('json', connectionUpdateSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const existing = await loadOwnedConnection(id, userId);
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
  await loadOwnedConnection(id, userId);
  // Cascade: bindings reference the connection with ON DELETE CASCADE, but we
  // only soft-delete here (active=false) so existing bindings stop resolving via
  // findActiveBinding's `connection.active` filter without dropping audit rows.
  await softDeleteConnection(id);
  return c.json({ ok: true });
});
