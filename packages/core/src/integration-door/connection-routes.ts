import type { IntegrationRefusalCode } from '@forge/contracts/integrations';
import { SCHEMA_BASE } from '@forge/contracts/project-config';
import { say } from '@forge/contracts/said';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { listInstallationRepositories } from '../integrations/github/index.js';
import {
  adapterOrRefuse,
  applySecretsPatch,
  assertVaultConfigured,
  bindingItemsSchema,
  buildContextFromBinding,
  connectionConfigSchemaForProvider,
  connectionCreateSchema,
  connectionUpdateSchema,
  createConnection,
  decryptConnectionSecrets,
  defaultConnectionDisplayName,
  effectiveConfig,
  findConnectionById,
  healthOf,
  type IntegrationConnectionRow,
  listBindingsByConnectionIds,
  listBindingsForConnection,
  listConnectionsForPrincipalUser,
  notFound,
  notifyConnectionChanged,
  pendingConnectionRow,
  raceWithTimeout,
  reportedBindingIdentities,
  softDeleteConnection,
  summarizeConnection,
  summarizeConnectionWithUsage,
  TEST_PROBE_TIMEOUT_MS,
  updateConnection,
  withdrawNulls,
} from '../integrations/index.js';
import { SourceHostCallError } from '../integrations/source-host/index.js';
import { loadOrgRole, loadVisibleProjectIds } from '../lib/authz.js';
import { refused, refuser } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { isPlatformAdmin } from '../middleware/require-admin.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireOrgHeld } from '../permissions/index.js';
import { readDeployMap } from '../project-config/index.js';
import { summarizeBindings } from './binding-standing.js';
import { bindConnectionInto } from './connect-and-bind.js';
import { instanceInstallationsFor, suggestionsFor } from './github-reach.js';

/**
 * Reading a connection, as opposed to managing it. Every principal the list
 * route shows a connection to can also read it; only WRITING is gated, on org
 * admin for an org's, and on a platform admin for the instance's own.
 */
export async function loadConnection(
  id: string,
  userId: string,
  intent: 'read' | 'manage',
): Promise<IntegrationConnectionRow> {
  const connection = await findConnectionById(id);
  if (!connection) throw notFound('connection');
  if (connection.ownerType === 'instance') {
    if (intent === 'manage' && !(await isPlatformAdmin(userId))) {
      throw refuse(
        'GITHUB_APP_OPERATOR_ONLY',
        "this connection is the Forge instance's own, and only a Forge operator changes or removes it",
      );
    }
    return connection;
  }
  if (connection.ownerType === 'user') {
    if (connection.ownerId !== userId) throw notFound('connection');
    return connection;
  }
  const orgRole = await loadOrgRole(connection.ownerId, userId);
  if (!orgRole) throw notFound('connection');
  if (intent === 'manage') requireOrgHeld(connection.ownerId, orgRole, 'org.admin');
  return connection;
}

/**
 * Where each connection is used, as far as this caller may see. Every org binds the instance's App,
 * so its bindings are narrowed to the projects the caller sees: another org's projects and the
 * repositories they bind are not theirs to read.
 */
async function usageVisibleTo<B extends { projectId: string }>(
  userId: string,
  rows: readonly IntegrationConnectionRow[],
  bindings: Map<string, B[]>,
): Promise<Map<string, B[]>> {
  if (!rows.some((r) => r.ownerType === 'instance')) return bindings;
  const visible = new Set(await loadVisibleProjectIds(userId));
  const out = new Map(bindings);
  for (const row of rows) {
    if (row.ownerType !== 'instance') continue;
    out.set(
      row.id,
      (bindings.get(row.id) ?? []).filter((b) => visible.has(b.projectId)),
    );
  }
  return out;
}

const refuse = refuser<IntegrationRefusalCode>('INTEGRATION_REFUSED');

export const integrationConnectionsRoutes = new Hono<{ Variables: AuthVars }>();
integrationConnectionsRoutes.use('*', requireAuth(), assertEmailVerified());

integrationConnectionsRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const rows = await listConnectionsForPrincipalUser(userId);
  const bindings = await usageVisibleTo(
    userId,
    rows,
    await listBindingsByConnectionIds(rows.map((r) => r.id)),
  );
  const projectIds = [...new Set([...bindings.values()].flat().map((b) => b.projectId))];
  const deployMaps = new Map(
    await Promise.all(projectIds.map(async (id) => [id, await readDeployMap(id)] as const)),
  );
  const environmentOf = (b: { id: string; projectId: string }) =>
    deployMaps.get(b.projectId)?.environments.get(b.id)?.name ?? null;
  const reported = await reportedBindingIdentities(
    rows.flatMap((connection) =>
      (bindings.get(connection.id) ?? []).map((binding) => ({
        id: binding.id,
        provider: binding.provider,
        config: effectiveConfig({ binding, connection }),
        connection,
      })),
    ),
  );
  return c.json({
    items: rows.map((r) =>
      summarizeConnectionWithUsage(r, bindings.get(r.id) ?? [], environmentOf, reported),
    ),
  });
});

integrationConnectionsRoutes.post('/', zValidator('json', connectionCreateSchema), async (c) => {
  const userId = c.get('userId');
  assertVaultConfigured();
  const body = c.req.valid('json');
  // orgId present = an org-owned connection (shared across the org's
  // projects); requires org admin. Absent = personal (user-owned).
  if (body.orgId) {
    const orgRole = await loadOrgRole(body.orgId, userId);
    if (!orgRole) throw notFound('org');
    requireOrgHeld(body.orgId, orgRole, 'org.admin');
  }
  const connection = pendingConnectionRow({
    ownerType: body.orgId ? 'org' : 'user',
    ownerId: body.orgId ?? userId,
    provider: body.provider,
    displayName: body.displayName ?? defaultConnectionDisplayName(body.provider, body.config ?? {}),
    config: body.config,
    secrets: body.secrets,
  });
  if (!body.bindings) {
    await createConnection(connection);
    notifyConnectionChanged(body.provider, connection.id);
    return c.json({ connection: summarizeConnection(connection), bindings: [] }, 201);
  }
  const bound = await bindConnectionInto({
    userId,
    connection,
    items: body.bindings,
    store: true,
  });
  if (!bound.ok) return refused(c, bound.refusals, 'CONFIG_REFUSED');
  notifyConnectionChanged(body.provider, connection.id);
  return c.json({ connection: summarizeConnection(connection), bindings: bound.bindings }, 201);
});

/** Bind a connection that already exists into several projects, as one write. */
integrationConnectionsRoutes.post(
  '/:id/bindings',
  zValidator('json', z.strictObject({ bindings: bindingItemsSchema })),
  async (c) => {
    const userId = c.get('userId');
    const connection = await loadConnection(c.req.param('id'), userId, 'read');
    const bound = await bindConnectionInto({
      userId,
      connection,
      items: c.req.valid('json').bindings,
    });
    if (!bound.ok) return refused(c, bound.refusals, 'CONFIG_REFUSED');
    return c.json({ bindings: bound.bindings });
  },
);

/**
 * What this connection can be bound to, as binding-v1 targets a `bindings[].target` takes as they
 * stand: the repositories a GitHub App's installations granted, with the one each unbound project the
 * caller administers is offered pre-ticked (`suggestedFor`). A provider whose target is typed rather
 * than listed is refused by name, with the fields its target takes.
 */
integrationConnectionsRoutes.get('/:id/targets', async (c) => {
  const connection = await loadConnection(c.req.param('id'), c.get('userId'), 'read');
  if (connection.provider !== 'github') {
    return refused(
      c,
      [
        {
          code: 'TARGETS_NOT_LISTED',
          path: '',
          detail: `a ${connection.provider} connection's targets are not listed here; its binding-v1 target is typed with the fields ${SCHEMA_BASE}/binding-v1.json names for target.provider "${connection.provider}".`,
        },
      ],
      'CONFIG_REFUSED',
    );
  }
  const { appId, privateKey } = decryptConnectionSecrets<{ appId?: string; privateKey?: string }>(
    connection,
  );
  if (!appId || !privateKey) throw badRequest({ id: 'the App was never converted' });
  try {
    const listed = await listInstallationRepositories({
      appId,
      privateKey,
      // the instance's App lists only what was recorded for the caller's orgs or is bound already
      ...(connection.ownerType === 'instance'
        ? { installations: await instanceInstallationsFor(c.get('userId'), connection.id) }
        : {}),
    });
    const targets = listed.repositories.map((r) => ({
      provider: 'github' as const,
      installationId: r.installationId,
      owner: r.owner,
      repo: r.repo,
    }));
    return c.json({
      targets,
      truncated: listed.truncated,
      suggestedFor: await suggestionsFor(c.get('userId'), targets),
    });
  } catch (err) {
    if (!(err instanceof SourceHostCallError)) throw err;
    throw new HTTPException(502, {
      message: `${err.message}, so the repositories this App can see are unknown${err.detail ? `: ${err.detail}` : ''}`,
      cause: { code: 'GITHUB_REFUSED', details: { httpStatus: err.status } },
    });
  }
});

integrationConnectionsRoutes.get('/:id/bindings', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  const connection = await loadConnection(id, userId, 'read');
  const visible =
    connection.ownerType === 'instance' ? new Set(await loadVisibleProjectIds(userId)) : null;
  const pairs = (await listBindingsForConnection(id)).filter(
    (pair) => visible === null || visible.has(pair.binding.projectId),
  );
  const bindings = await summarizeBindings(pairs);
  return c.json({ items: bindings });
});

integrationConnectionsRoutes.post('/:id/test', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  await loadConnection(id, userId, 'manage');

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

  const adapter = adapterOrRefuse(pair.binding.provider);
  // Time-boxed like the health sweep — a blackholed provider must not pin the
  // HTTP request open indefinitely. A timeout is reported as a truthful error
  // result, not a 5xx (the adapter keeps running and persists its own outcome).
  const result = await raceWithTimeout(
    adapter.healthcheck(buildContextFromBinding(pair)),
    TEST_PROBE_TIMEOUT_MS,
  );
  if (result === null) {
    return c.json(
      healthOf(
        'error',
        say('integrations.health.timedOut', { seconds: TEST_PROBE_TIMEOUT_MS / 1000 }),
      ),
    );
  }
  return c.json(result);
});

integrationConnectionsRoutes.patch(
  '/:id',
  zValidator('json', connectionUpdateSchema),
  async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const existing = await loadConnection(id, userId, 'manage');
    const patch = c.req.valid('json');

    const connPatch: Parameters<typeof updateConnection>[1] = {};
    if (patch.displayName !== undefined) connPatch.displayName = patch.displayName;
    if (patch.active !== undefined) connPatch.active = patch.active;
    if (patch.config) {
      const parsed = connectionConfigSchemaForProvider(existing.provider).safeParse(patch.config);
      if (!parsed.success) throw badRequest(parsed.error);
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
  const existing = await loadConnection(id, userId, 'manage');
  // Cascade: bindings reference the connection with ON DELETE CASCADE, but we
  // only soft-delete here (active=false) so existing bindings stop resolving via
  // the resolvers' `connection.active` filter without dropping audit rows.
  await softDeleteConnection(id);
  notifyConnectionChanged(existing.provider, id);
  return c.json({ ok: true });
});
