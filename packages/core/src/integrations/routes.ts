import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { db } from '../db/client.js';
import {
  integrationDeliveries,
  type IntegrationEnvironment,
  integrationEnvironments,
  projectIntegrations,
  projectMembers,
  projects,
} from '../db/schema.js';
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

export async function loadIntegrationsForProvider(
  provider: IntegrationProvider,
  projectId: string,
) {
  return listForProjectProvider(projectId, provider);
}
