import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from '../db/client.js';
import {
  devices,
  integrationDeliveries,
  type IntegrationEnvironment,
  integrationEnvironments,
  projectIntegrations,
  projectMembers,
  projects,
  runners,
} from '../db/schema.js';
import { classifyGitRemote } from '../git/provision-credential.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import type { CoolifySecrets } from './coolify/types.js';
import { getAdapter } from './registry.js';
import {
  buildContext,
  createIntegration,
  findById,
  listForProjectProvider,
  softDeleteIntegration,
  updateIntegration,
} from './store.js';
import type { IntegrationProvider } from './types.js';
import { isVaultConfigured } from './vault.js';

// `assertVaultBootSafety` lets core boot when project_integrations is empty,
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

const ROTATION_WINDOW_MS = 24 * 60 * 60_000;

async function assertProjectMember(projectId: string, userId: string): Promise<'owner' | 'admin' | 'member'> {
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

const providerSchema = z.enum(['coolify']);
const environmentSchema = z.enum(integrationEnvironments);

const coolifyConfigSchema = z.object({
  baseUrl: z.string().url().max(500),
  resourceUuid: z.string().min(1).max(200),
  branch: z.string().min(1).max(200),
});

const coolifySecretsSchema = z.object({
  apiToken: z.string().min(8).max(2000),
});

const createSchema = z.object({
  provider: providerSchema,
  environment: environmentSchema,
  config: coolifyConfigSchema,
  secrets: coolifySecretsSchema,
});

const updateSchema = z.object({
  config: coolifyConfigSchema.partial().optional(),
  secrets: coolifySecretsSchema.partial().optional(),
  active: z.boolean().optional(),
});

function summarize(row: typeof projectIntegrations.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    provider: row.provider as IntegrationProvider,
    environment: row.environment as IntegrationEnvironment,
    config: row.config,
    active: row.active,
    lastHealthStatus: row.lastHealthStatus,
    lastHealthAt: row.lastHealthAt,
    breakerOpenedAt: row.breakerOpenedAt,
    hasSecrets: row.secretsEnc !== null,
    integrationSecretSet: row.integrationSecret !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const integrationsRoutes = new Hono<{ Variables: AuthVars }>();
integrationsRoutes.use('*', requireAuth(), assertEmailVerified());

integrationsRoutes.get('/:projectId/integrations', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  const rows = await db
    .select()
    .from(projectIntegrations)
    .where(eq(projectIntegrations.projectId, projectId))
    .orderBy(desc(projectIntegrations.createdAt));
  return c.json({ items: rows.map(summarize) });
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
    // Auto-mint an HMAC secret for inbound webhook verification.
    const integrationSecret = `whsec_${randomBytes(24).toString('hex')}`;

    try {
      const created = await createIntegration({
        projectId,
        provider: body.provider,
        environment: body.environment,
        config: { ...body.config, environment: body.environment },
        secrets: body.secrets,
        integrationSecret,
      });
      return c.json({ integration: summarize(created), integrationSecret }, 201);
    } catch (err) {
      // Postgres unique-violation error code is the durable signal here;
      // fall back to message scan only when the driver hides the code.
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

    const existing = await findById(id);
    if (!existing || existing.projectId !== projectId) throw notFound();

    const patch = c.req.valid('json');
    const mergedConfig = patch.config ? { ...(existing.config as object), ...patch.config } : undefined;

    // Token rotation — keep the previous token for 24h so deploys in flight
    // when the operator updates the token still authenticate.
    let mergedSecrets: Record<string, unknown> | null | undefined = undefined;
    if (patch.secrets?.apiToken) {
      // Only guard the vault when this PATCH touches encrypted material —
      // config-only patches must keep working even if the key is missing.
      assertVaultConfigured();
      const currentSecrets = existing.secretsEnc
        ? (await import('./vault.js')).decryptJson<CoolifySecrets>(existing.secretsEnc)
        : null;
      mergedSecrets = {
        apiToken: patch.secrets.apiToken,
        previousApiToken: currentSecrets?.apiToken,
        previousTokenExpiresAt: currentSecrets?.apiToken
          ? new Date(Date.now() + ROTATION_WINDOW_MS).toISOString()
          : undefined,
      };
    }

    const updatePatch: Parameters<typeof updateIntegration>[1] = {};
    if (mergedConfig !== undefined) updatePatch.config = mergedConfig;
    if (mergedSecrets !== undefined) updatePatch.secrets = mergedSecrets;
    if (patch.active !== undefined) updatePatch.active = patch.active;
    const updated = await updateIntegration(id, updatePatch);
    if (!updated) throw notFound();
    return c.json({ integration: summarize(updated) });
  },
);

integrationsRoutes.delete('/:projectId/integrations/:id', async (c) => {
  const projectId = c.req.param('projectId');
  const id = c.req.param('id');
  const userId = c.get('userId');
  const role = await assertProjectMember(projectId, userId);
  assertAdmin(role);

  const existing = await findById(id);
  if (!existing || existing.projectId !== projectId) throw notFound();

  await softDeleteIntegration(id);
  return c.json({ ok: true });
});

integrationsRoutes.post('/:projectId/integrations/:id/test', async (c) => {
  const projectId = c.req.param('projectId');
  const id = c.req.param('id');
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  const existing = await findById(id);
  if (!existing || existing.projectId !== projectId) throw notFound();

  const adapter = getAdapter(existing.provider);
  if (!adapter) {
    throw new HTTPException(400, {
      message: `no adapter registered for provider=${existing.provider}`,
      cause: { code: 'NO_ADAPTER' },
    });
  }
  const ctx = buildContext(existing);
  const result = await adapter.healthcheck(ctx);
  return c.json(result);
});

integrationsRoutes.post('/:projectId/integrations/:id/rotate-secret', async (c) => {
  const projectId = c.req.param('projectId');
  const id = c.req.param('id');
  const userId = c.get('userId');
  const role = await assertProjectMember(projectId, userId);
  assertAdmin(role);

  const existing = await findById(id);
  if (!existing || existing.projectId !== projectId) throw notFound();

  const newSecret = `whsec_${randomBytes(24).toString('hex')}`;
  const updated = await updateIntegration(id, { integrationSecret: newSecret });
  if (!updated) throw notFound();
  return c.json({ integration: summarize(updated), integrationSecret: newSecret });
});

integrationsRoutes.post('/:projectId/integrations/:id/confirm-prod-deploy', async (c) => {
  const projectId = c.req.param('projectId');
  const id = c.req.param('id');
  const userId = c.get('userId');
  const role = await assertProjectMember(projectId, userId);
  assertAdmin(role);

  const existing = await findById(id);
  if (!existing || existing.projectId !== projectId) throw notFound();
  if (existing.environment !== 'prod') {
    throw new HTTPException(400, {
      message: 'confirm-prod-deploy is only valid on prod-environment integrations',
      cause: { code: 'NOT_PROD_ENV' },
    });
  }
  // Lazy import to avoid an import cycle (release-coolify imports the
  // adapter, which would transitively import these routes).
  const { confirmPendingProdDeploy } = await import('../pipeline/release-coolify.js');
  const result = await confirmPendingProdDeploy(id);
  return c.json(result);
});

integrationsRoutes.get('/:projectId/integrations/:id/deliveries', async (c) => {
  const projectId = c.req.param('projectId');
  const id = c.req.param('id');
  const userId = c.get('userId');
  await assertProjectMember(projectId, userId);

  const existing = await findById(id);
  if (!existing || existing.projectId !== projectId) throw notFound();

  const rows = await db
    .select()
    .from(integrationDeliveries)
    .where(eq(integrationDeliveries.projectIntegrationId, id))
    .orderBy(desc(integrationDeliveries.createdAt))
    .limit(50);
  return c.json({ items: rows });
});

// === ISS-305 — composed read-only integrations status for the web hub ===
//
// Aggregates ONLY real, already-existing signals — no fabricated metrics. Each
// card carries a status the UI renders with icon + text (never color-only) plus
// a last-sync timestamp where one genuinely exists. Providers with no backing
// data render `not_configured` rather than inventing health.

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

  const integrationRows = await db
    .select()
    .from(projectIntegrations)
    .where(eq(projectIntegrations.projectId, projectId));

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

  // --- Coolify (one card per configured integration) ---
  const coolifyRows = integrationRows.filter((r) => r.provider === 'coolify');
  if (coolifyRows.length === 0) {
    cards.push({
      key: 'coolify',
      label: 'Coolify',
      status: 'not_configured',
      detail: 'no Coolify integration configured',
      lastSyncAt: null,
      configured: false,
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
        meta: { environment: row.environment, breakerOpen: row.breakerOpenedAt !== null },
      });
    }
  }

  // --- Runners / devices online ---
  const totalRunners = runnerRows.length;
  const onlineRunners = runnerRows.filter((r) => r.status === 'online').length;
  cards.push({
    key: 'runners',
    label: 'Runners',
    status:
      totalRunners === 0 ? 'not_configured' : onlineRunners > 0 ? 'connected' : 'attention',
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

export async function loadIntegrationsForProvider(
  provider: IntegrationProvider,
  projectId: string,
) {
  return listForProjectProvider(projectId, provider);
}
