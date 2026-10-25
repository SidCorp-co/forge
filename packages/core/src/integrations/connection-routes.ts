import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { loadOrgRole, orgRoleAtLeast } from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { AGENT_ACCESS_CLOSED, AGENT_ACCESS_VALUES, type AgentAccess } from './agent-access.js';
import { bindingReaderOf } from './binding-acts.js';
import { refuseNewBinding } from './binding-doors.js';
import { checkBindingHealth } from './binding-health.js';
import {
  cannotDeployMessage,
  checkRoleStagesPairing,
  roleSchema,
  stagesSchema,
} from './binding-shape.js';
import {
  bindConnection,
  boundConnectionSchema,
  changeConnection,
  connectionAnswerSchema,
  connectionBindingListSchema,
  directorySchema,
  healthResultSchema,
  listConnectionBindings,
  listConnections,
  listConnectionsQuerySchema,
  okSchema,
  removeConnection,
  storeConnection,
  testConnection,
} from './connection-routes-reference.js';
import { healthAnswer } from './health-words.js';
import { holdsKey, isRemovedConnection, keyIn, MANAGES_IT } from './held-key.js';
import { ownerNamesOf } from './owner-names.js';
import { raceWithTimeout } from './probe.js';
import {
  applySecretsPatch,
  bindingConfigPatch,
  connectionConfigSchemaForProvider,
  connectionCreateSchema,
  connectionUpdateSchema,
  parseProviderHalf,
  splitProviderConfig,
} from './provider-schemas.js';
import {
  bindingsVisibleTo,
  findReachableConnection,
  listReachableConnections,
  memberProjectsBoundTo,
  type ReachedConnection,
} from './reach.js';
import { getAdapter, getIntegration, providerCanDeploy } from './registry.js';
import { withdrawNulls } from './release-channel-schema.js';
import {
  alreadyExists,
  assertNoActiveBindingClash,
  assertNotRemoved,
  assertProjectMember,
  assertVaultConfigured,
  badRequest,
  buildCreatedBindingResponse,
  connectionChangedWhileCleared,
  connectionGoneOrNotReachable,
  connectionNotReachable,
  defaultConnectionDisplayName,
  healthOnKeySaved,
  notFound,
  notifyConnectionChanged,
  summarizeBinding,
  summarizeConnection,
  summarizeConnectionWithUsage,
  TEST_PROBE_TIMEOUT_MS,
  turnsBackOn,
} from './route-helpers.js';
import {
  clearRemovedConnection,
  createBinding,
  createConnection,
  type IntegrationConnectionRow,
  listBindingsByConnectionIds,
  listBindingsForConnection,
  softDeleteConnection,
  updateConnection,
} from './store.js';
import type { IntegrationProvider } from './types.js';
import {
  type ConnectionAct,
  connectionNotManageable,
  connectionPatchAct,
  orgCredentialNotYours,
} from './who-may-refusals.js';

/**
 * The connection and how the caller reaches it, or the refusal that names why not. Reach decides
 * what a caller is shown; only `canManage` decides what they may change.
 */
async function loadVisibleConnection(id: string, userId: string): Promise<ReachedConnection> {
  const reached = await findReachableConnection(userId, id);
  if (!reached) throw connectionNotReachable(id);
  return reached;
}

async function loadManageableConnection(
  id: string,
  userId: string,
  act: ConnectionAct,
): Promise<IntegrationConnectionRow> {
  return manageable(await loadVisibleConnection(id, userId), act);
}

/** The connection, or the refusal naming the act it was asked (ISS-1421 r28). */
async function manageable(
  reached: ReachedConnection,
  act: ConnectionAct,
): Promise<IntegrationConnectionRow> {
  if (!reached.canManage) {
    const names = await ownerNamesOf([reached.connection]);
    throw connectionNotManageable(
      reached.connection,
      names.get(reached.connection.id) ?? null,
      act,
    );
  }
  return reached.connection;
}

export const integrationConnectionsRoutes = new Hono<{ Variables: AuthVars }>();
integrationConnectionsRoutes.use('*', requireAuth(), assertEmailVerified());

integrationConnectionsRoutes.get(
  '/',
  listConnections,
  zValidator('query', listConnectionsQuerySchema),
  async (c) => {
    const userId = c.get('userId');
    const { orgId } = c.req.valid('query');
    const reached = (await listReachableConnections(userId)).filter(
      (r) => !orgId || (r.connection.ownerType === 'org' && r.connection.ownerId === orgId),
    );
    const bindings = await listBindingsByConnectionIds(reached.map((r) => r.connection.id));
    const ownerNames = await ownerNamesOf(reached.map((r) => r.connection));
    return c.json(
      answer(directorySchema, {
        items: reached.map((r) =>
          summarizeConnectionWithUsage(
            r.connection,
            bindingsVisibleTo(r, bindings.get(r.connection.id) ?? [], (b) => b.projectId),
            {
              reach: r.reach,
              canManage: r.canManage,
              ownerName: ownerNames.get(r.connection.id) ?? null,
            },
          ),
        ),
      }),
    );
  },
);

integrationConnectionsRoutes.post(
  '/',
  storeConnection,
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
      if (!orgRoleAtLeast(orgRole, 'admin')) throw orgCredentialNotYours('create');
    }
    const connection = await createConnection({
      ownerType: body.orgId ? 'org' : 'user',
      ownerId: body.orgId ?? userId,
      provider: body.provider,
      displayName: body.displayName ?? defaultConnectionDisplayName(body.config ?? {}),
      config: body.config,
      secrets: body.secrets,
    });
    notifyConnectionChanged(body.provider, connection.id);
    return c.json(
      answer(connectionAnswerSchema, { connection: summarizeConnection(connection) }),
      201,
    );
  },
);

// Bind an EXISTING connection to a project — no secrets (the connection
// already holds the credential). Owner-only on the connection + admin on the
// TARGET project. Contrast the create path (POST /:projectId/integrations) which
// always mints a NEW connection from the request body's secrets.
const bindExistingSchema = z
  .object({
    projectId: z.uuid(),
    role: roleSchema,
    stages: stagesSchema.optional(),
    // Binding-tier overrides (coolify resourceUuid/branch) so a shared connection
    // can target a different Coolify resource per project. Connection-tier keys
    // are validated then dropped — a bind must not shadow the shared baseUrl.
    config: z.record(z.string(), z.unknown()).optional(),
    // ISS-1071 — the third door onto `integration_bindings`, so it takes the same field. Sharing an
    // existing credential into a project is still a connect, and whether agents there may use it is
    // still a property of the binding it creates rather than of a map somewhere else.
    agentAccess: z.enum(AGENT_ACCESS_VALUES).optional(),
  })
  .superRefine((body, ctx) => {
    checkRoleStagesPairing(body, ctx);
  });

integrationConnectionsRoutes.post(
  '/:id/bindings',
  ...bindConnection,
  zValidator('json', bindExistingSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    // user-owned: owner-only; org-owned: org admin (not-found for outsiders).
    const connection = await loadManageableConnection(id, userId, 'share it with a project');
    // A binding to a removed connection resolves nothing (ISS-1421 r22).
    await assertNotRemoved(connection, 'shared', MANAGES_IT);
    const body = c.req.valid('json');
    // The target project's side, by the rule its list's `may` answers, the agents grant with it (ISS-1421 r28).
    const role = await assertProjectMember(body.projectId, userId);
    refuseNewBinding(await bindingReaderOf(userId, body.projectId, role), connection.provider, {
      act: 'share a connection with it',
      grants: (body.agentAccess ?? AGENT_ACCESS_CLOSED) !== AGENT_ACCESS_CLOSED,
      orgOwned: false,
    });
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
    // The body is validated before the connection is loaded, so the provider-capability half of
    // `checkBindingShape` could not run there — the provider comes from the connection, not the body.
    if (body.role === 'deploy' && !providerCanDeploy(provider)) {
      throw badRequest(cannotDeployMessage(provider));
    }
    // One active SERVICE binding per (project, provider); deploy bindings are unconstrained.
    await assertNoActiveBindingClash(body.projectId, provider, body.role);

    // Optional per-project deploy-target overrides, validated against the
    // provider's partial schema then reduced to binding-tier keys only.
    let bindingConfig: Record<string, unknown> = {};
    if (body.config) {
      const config = bindingConfigPatch(provider, body.config);
      bindingConfig = splitProviderConfig(provider, config).binding;
    }

    const bindingAgentAccess: AgentAccess = body.agentAccess ?? AGENT_ACCESS_CLOSED;

    const integrationSecret =
      getAdapter(provider)?.inboundSecret?.(connection) ??
      `whsec_${randomBytes(24).toString('hex')}`;
    let binding: Awaited<ReturnType<typeof createBinding>>;
    try {
      binding = await createBinding({
        connectionId: id,
        projectId: body.projectId,
        provider,
        role: body.role,
        ...(body.role === 'deploy' && body.stages ? { stages: body.stages } : {}),
        config: bindingConfig,
        integrationSecret,
        agentAccess: bindingAgentAccess,
      });
    } catch (err) {
      // No connection rollback here — we did not create one (contrast the create
      // path, which soft-deletes its just-minted connection on a binding clash).
      if (isUniqueViolation(err)) throw alreadyExists();
      throw err;
    }
    // Whatever this provider declares it does on bind, and whatever it says the response should
    // carry about it. A provider declaring nothing adds nothing — there is no default to guess at.
    const bindEffects =
      (await getAdapter(provider)?.onBindingCreated?.({
        projectId: body.projectId,
        role: body.role,
        config: bindingConfig as Record<string, unknown>,
      })) ?? {};
    notifyConnectionChanged(provider, id);
    // Re-probe on bind so the target project starts from current health rather
    // than whatever the connection last recorded (ISS-429).
    return c.json(
      answer(boundConnectionSchema, {
        ...(await buildCreatedBindingResponse(
          { binding, connection },
          integrationSecret,
          await bindingReaderOf(userId, body.projectId, role),
        )),
        ...bindEffects,
      }),
      201,
    );
  },
);

integrationConnectionsRoutes.get('/:id/bindings', ...listConnectionBindings, async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  const [reached, memberOf] = await Promise.all([
    findReachableConnection(userId, id),
    memberProjectsBoundTo(userId, id),
  ]);
  if (!reached && memberOf.length === 0) throw connectionNotReachable(id);
  const all = await listBindingsForConnection(id);
  const shown = new Set(memberOf);
  const pairs = all.filter(
    (pair) =>
      shown.has(pair.binding.projectId) ||
      (reached !== null &&
        bindingsVisibleTo(reached, [pair], (p) => p.binding.projectId).length > 0),
  );
  const bindings = pairs.map(summarizeBinding);
  return c.json(answer(connectionBindingListSchema, { bindings, items: bindings }));
});

integrationConnectionsRoutes.post('/:id/test', ...testConnection, async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  const connection = await loadManageableConnection(id, userId, 'test it');
  // A removed connection holds nothing a check could pass, so none is recorded (ISS-1421 r22).
  await assertNotRemoved(connection, 'tested', MANAGES_IT);

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
  const result = await raceWithTimeout(checkBindingHealth(adapter, pair), TEST_PROBE_TIMEOUT_MS);
  const provider = pair.binding.provider;
  if (result === null) {
    return c.json(
      answer(
        healthResultSchema,
        healthAnswer(provider, { status: 'error', message: 'No answer came within 10 seconds.' }),
      ),
    );
  }
  return c.json(answer(healthResultSchema, healthAnswer(provider, result)));
});

integrationConnectionsRoutes.patch(
  '/:id',
  ...changeConnection,
  zValidator('json', connectionUpdateSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const id = c.req.param('id');
    const userId = c.get('userId');
    const patch = c.req.valid('json');
    const existing = await loadManageableConnection(id, userId, connectionPatchAct(patch));

    const connPatch: Parameters<typeof updateConnection>[1] = {};
    if (patch.displayName !== undefined) connPatch.displayName = patch.displayName;
    if (patch.active !== undefined) connPatch.active = patch.active;
    if (patch.config) {
      const schema = connectionConfigSchemaForProvider(existing.provider);
      const config = parseProviderHalf(schema, patch.config, 'config');
      // `withdrawNulls` as the binding PATCH does: a key sent as null is REMOVED. Storing one
      // left a withdrawn `releaseRunnerLabel` on the row as a null forever (ISS-1127, ISS-1275).
      connPatch.config = withdrawNulls({
        ...((existing.config ?? {}) as object),
        ...config,
      });
    }
    if (patch.secrets) {
      const merged = await applySecretsPatch({
        provider: existing.provider,
        rawSecrets: patch.secrets,
        connection: existing,
        // Historical order on this path: vault guard fires before the parse.
        vaultGuardTiming: 'before-parse',
      });
      if (merged !== undefined) connPatch.secrets = merged;
    }

    // A deleted connection holds no key, and turning it on again takes a new one (ISS-1421 r20):
    // the key itself, not another secret saved beside it.
    const primary = getIntegration(existing.provider)?.schemas.primaryCredentialField;
    const keyed =
      !primary ||
      (connPatch.secrets !== undefined
        ? keyIn(existing.provider, connPatch.secrets)
        : holdsKey(existing));
    if (patch.active === true && !keyed) {
      throw new HTTPException(409, {
        message: await noKeyRefusal(existing),
        cause: { code: 'CONNECTION_HAS_NO_KEY' },
      });
    }

    // A new key makes the last check a check of a key no longer used (ISS-1421 r21): the connection
    // reads Not checked yet until Test connection judges the key just saved.
    if (connPatch.secrets !== undefined) {
      Object.assign(connPatch, healthOnKeySaved(existing.provider, patch.secrets ?? {}));
    }

    const updated = await updateConnection(id, connPatch);
    if (!updated) throw notFound('connection');
    notifyConnectionChanged(existing.provider, id);
    return c.json(answer(connectionAnswerSchema, { connection: summarizeConnection(updated) }));
  },
);

/** Turning on a connection that holds no key: removing it wiped its keys. */
async function noKeyRefusal(connection: Parameters<typeof turnsBackOn>[0]): Promise<string> {
  return `This connection holds no key, as removing it wiped its keys. ${await turnsBackOn(connection, MANAGES_IT)}`;
}

/** The connection a delete names, where a connection no longer there answers as gone. */
async function loadDeletableConnection(id: string, userId: string) {
  const reached = await findReachableConnection(userId, id);
  if (!reached) throw connectionGoneOrNotReachable(id);
  return manageable(reached, 'remove it');
}

integrationConnectionsRoutes.delete('/:id', ...removeConnection, async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');
  const existing = await loadDeletableConnection(id, userId);
  // The first delete switches the row off and wipes every key on it (ISS-1421 r20), so its bindings
  // stop resolving; a delete of a connection already removed clears it from the list (ISS-1421 r21).
  if (!isRemovedConnection(existing)) await softDeleteConnection(id);
  else if (!(await clearRemovedConnection(existing))) {
    // Cleared by another request, it answers as gone; still standing, it changed under this one.
    await loadDeletableConnection(id, userId);
    throw connectionChangedWhileCleared();
  }
  notifyConnectionChanged(existing.provider, id);
  return c.json(answer(okSchema, { ok: true }));
});
