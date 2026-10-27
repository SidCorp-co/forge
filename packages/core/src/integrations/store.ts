import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type BindingRole,
  type DeployStage,
  type IntegrationOwnerType,
  integrationBindings,
  integrationConnections,
  type ObservedEndpoint,
} from '../db/schema.js';
import { AGENT_ACCESS_CLOSED, type AgentAccess } from './agent-access.js';
import { CredentialUnreadable } from './credential-unreadable.js';
import type { AdapterContext, IntegrationProvider } from './types.js';
import { decryptJson, encryptJson, SecretUnreadableError } from './vault.js';

// Reads + CRUD over the integration tables. Since the ISS-399 cutover these are
// the live read path for resolvers / MCP tools / inbound router; the legacy
// project_integrations helpers they replaced were removed by ISS-410 (epic F5).

export type IntegrationConnectionRow = typeof integrationConnections.$inferSelect;
export type IntegrationBindingRow = typeof integrationBindings.$inferSelect;

/** A binding joined to its parent connection — the unit a dispatch needs. */
export interface BindingWithConnection {
  binding: IntegrationBindingRow;
  connection: IntegrationConnectionRow;
}

export async function findConnectionById(id: string): Promise<IntegrationConnectionRow | null> {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findBindingById(id: string): Promise<IntegrationBindingRow | null> {
  const rows = await db
    .select()
    .from(integrationBindings)
    .where(eq(integrationBindings.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Exactly the rows `integration_bindings_service_uq` holds to one, whatever its connection's state:
 * a create this finds nothing for, the index admits (ISS-1421 r32). Service-only on purpose, as the
 * index is: a deploy binding on the same provider is a different declaration (ISS-1046 rule 3).
 */
export async function findSwitchedOnServiceBindingAtLabel(
  projectId: string,
  provider: IntegrationProvider,
  label: string,
  exceptBindingId?: string,
): Promise<BindingWithConnection | null> {
  const rows = await db
    .select({ binding: integrationBindings, connection: integrationConnections })
    .from(integrationBindings)
    .innerJoin(
      integrationConnections,
      eq(integrationBindings.connectionId, integrationConnections.id),
    )
    .where(
      and(
        eq(integrationBindings.projectId, projectId),
        eq(integrationBindings.provider, provider),
        eq(integrationBindings.label, label),
        eq(integrationBindings.role, 'service'),
        eq(integrationBindings.active, true),
        exceptBindingId ? ne(integrationBindings.id, exceptBindingId) : undefined,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Every active DEPLOY binding for a project + provider, oldest first.
 *
 * The deploy and control paths ask "which of this provider's bindings can Forge push to", which is
 * a different question from "which of them exist". A `service` binding is a facility the project
 * uses — an error tracker, a chat room, a storefront borrowed for its MCP — and enqueueing a
 * deploy against one is the retired model reappearing under a new column name.
 */
export async function listActiveDeployBindingsForProvider(
  projectId: string,
  provider: IntegrationProvider,
): Promise<BindingWithConnection[]> {
  return db
    .select({ binding: integrationBindings, connection: integrationConnections })
    .from(integrationBindings)
    .innerJoin(
      integrationConnections,
      eq(integrationBindings.connectionId, integrationConnections.id),
    )
    .where(
      and(
        eq(integrationBindings.projectId, projectId),
        eq(integrationBindings.provider, provider),
        eq(integrationBindings.role, 'deploy'),
        eq(integrationBindings.active, true),
        eq(integrationConnections.active, true),
      ),
    )
    .orderBy(asc(integrationBindings.createdAt));
}

export async function findActiveBinding(
  projectId: string,
  provider: IntegrationProvider,
): Promise<BindingWithConnection | null> {
  const rows = await db
    .select({ binding: integrationBindings, connection: integrationConnections })
    .from(integrationBindings)
    .innerJoin(
      integrationConnections,
      eq(integrationBindings.connectionId, integrationConnections.id),
    )
    .where(
      and(
        eq(integrationBindings.projectId, projectId),
        eq(integrationBindings.provider, provider),
        eq(integrationBindings.active, true),
        eq(integrationConnections.active, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * All active bindings (+ connections) for a project + provider, across
 * stages and roles. Used by the inbound webhook router to find the right binding
 * when the payload carries a provider hint.
 */
export async function listActiveBindingsForProjectProvider(
  projectId: string,
  provider: IntegrationProvider,
): Promise<BindingWithConnection[]> {
  return db
    .select({ binding: integrationBindings, connection: integrationConnections })
    .from(integrationBindings)
    .innerJoin(
      integrationConnections,
      eq(integrationBindings.connectionId, integrationConnections.id),
    )
    .where(
      and(
        eq(integrationBindings.projectId, projectId),
        eq(integrationBindings.provider, provider),
        eq(integrationBindings.active, true),
        eq(integrationConnections.active, true),
      ),
    )
    .orderBy(asc(integrationBindings.createdAt));
}

export async function listActiveDeployBindingsForStage(
  projectId: string,
  stage: DeployStage,
): Promise<BindingWithConnection[]> {
  return db
    .select({ binding: integrationBindings, connection: integrationConnections })
    .from(integrationBindings)
    .innerJoin(
      integrationConnections,
      eq(integrationBindings.connectionId, integrationConnections.id),
    )
    .where(
      and(
        eq(integrationBindings.projectId, projectId),
        eq(integrationBindings.role, 'deploy'),
        sql`${stage} = ANY(${integrationBindings.stages})`,
        eq(integrationBindings.active, true),
        eq(integrationConnections.active, true),
      ),
    )
    .orderBy(asc(integrationBindings.createdAt));
}

/**
 * Decrypt a connection's secrets blob, or `{}` when it has none. One this server's key cannot open
 * is refused as {@link CredentialUnreadable}, naming the connection and the binding it was read
 * through. `bindingId` is required so a reader holding a binding cannot leave it out by omission:
 * `null` says this reader holds none (ISS-1259 r2).
 */
export function decryptConnectionSecrets<
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
>(connection: IntegrationConnectionRow, bindingId: string | null): TSecrets {
  if (!connection.secretsEnc) return {} as TSecrets;
  try {
    return decryptJson<TSecrets>(connection.secretsEnc);
  } catch (err) {
    if (!(err instanceof SecretUnreadableError)) throw err;
    throw new CredentialUnreadable({
      connectionId: connection.id,
      provider: connection.provider,
      displayName: connection.displayName,
      ...(bindingId ? { bindingId } : {}),
    });
  }
}

/**
 * Effective config for a dispatch = connection.config overlaid with
 * binding.config (binding wins on key collisions).
 */
export function effectiveConfig<TConfig extends Record<string, unknown> = Record<string, unknown>>(
  pair: BindingWithConnection,
): TConfig {
  return {
    ...((pair.connection.config ?? {}) as object),
    ...((pair.binding.config ?? {}) as object),
  } as TConfig;
}

/**
 * Build an {@link AdapterContext} from a binding+connection pair — the
 * dispatch/inbound counterpart of the legacy {@link buildContext}. Threads
 * `connectionId` (breaker/health target) + `bindingId` (delivery + inbound-HMAC
 * scope); config is the effective overlay; secrets come from the connection;
 * `integrationSecret` is the per-binding inbound HMAC.
 */
export function buildContextFromBinding<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
>(pair: BindingWithConnection): AdapterContext<TConfig, TSecrets> {
  return {
    connectionId: pair.connection.id,
    bindingId: pair.binding.id,
    projectId: pair.binding.projectId,
    provider: pair.binding.provider as IntegrationProvider,
    role: pair.binding.role as BindingRole,
    stages: (pair.binding.stages ?? []) as DeployStage[],
    config: effectiveConfig<TConfig>(pair),
    secrets: decryptConnectionSecrets<TSecrets>(pair.connection, pair.binding.id),
    integrationSecret: pair.binding.integrationSecret,
  };
}

export interface CreateConnectionInput {
  ownerType?: IntegrationOwnerType;
  ownerId: string;
  provider: IntegrationProvider;
  displayName?: string | null;
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown> | null;
}

export async function createConnection(
  input: CreateConnectionInput,
): Promise<IntegrationConnectionRow> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      ownerType: input.ownerType ?? 'user',
      ownerId: input.ownerId,
      provider: input.provider,
      displayName: input.displayName ?? null,
      config: input.config ?? {},
      secretsEnc: input.secrets ? encryptJson(input.secrets) : null,
      active: true,
    })
    .returning();
  if (!row) throw new Error('createConnection: insert returned no row');
  return row;
}

export interface UpdateConnectionPatch {
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown> | null;
  displayName?: string | null;
  active?: boolean;
  lastHealthStatus?: string | null;
  /** The sentence behind the status. Cleared with `null` so a stale reason never outlives it. */
  lastHealthDetail?: string | null;
  lastHealthAt?: Date | null;
  inboundEndpointObserved?: ObservedEndpoint | null;
  breakerOpenedAt?: Date | null;
}

export async function updateConnection(
  id: string,
  patch: UpdateConnectionPatch,
): Promise<IntegrationConnectionRow | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.config !== undefined) set.config = patch.config;
  if (patch.secrets !== undefined) {
    set.secretsEnc = patch.secrets ? encryptJson(patch.secrets) : null;
  }
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.lastHealthStatus !== undefined) set.lastHealthStatus = patch.lastHealthStatus;
  if (patch.lastHealthDetail !== undefined) set.lastHealthDetail = patch.lastHealthDetail;
  if (patch.lastHealthAt !== undefined) set.lastHealthAt = patch.lastHealthAt;
  if (patch.inboundEndpointObserved !== undefined)
    set.inboundEndpointObserved = patch.inboundEndpointObserved;
  if (patch.breakerOpenedAt !== undefined) set.breakerOpenedAt = patch.breakerOpenedAt;
  const [row] = await db
    .update(integrationConnections)
    .set(set)
    .where(eq(integrationConnections.id, id))
    .returning();
  return row ?? null;
}

export interface CreateBindingInput {
  connectionId: string;
  projectId: string;
  provider: IntegrationProvider;
  role: BindingRole;
  /** Empty for `service`; one or both stages for `deploy`. */
  stages?: DeployStage[];
  config?: Record<string, unknown>;
  integrationSecret?: string | null;
  /** ISS-558 — empty string (default) = unlabeled/default binding;
   *  non-empty kebab = a named extra epodsystem binding. */
  label?: string;
  /** ISS-1071 — whether agents on this project may use the binding. Closed unless asked for. */
  agentAccess?: AgentAccess;
}

export async function createBinding(input: CreateBindingInput): Promise<IntegrationBindingRow> {
  const [row] = await db
    .insert(integrationBindings)
    .values({
      connectionId: input.connectionId,
      projectId: input.projectId,
      provider: input.provider,
      role: input.role,
      stages: input.role === 'deploy' ? (input.stages ?? []) : [],
      config: input.config ?? {},
      integrationSecret: input.integrationSecret ?? null,
      label: input.label ?? '',
      active: true,
      agentAccess: input.agentAccess ?? AGENT_ACCESS_CLOSED,
    })
    .returning();
  if (!row) throw new Error('createBinding: insert returned no row');
  return row;
}

/**
 * A deleted connection: switched off, with every key stored on it wiped, the previous one included,
 * and the last check with them, since it judged a key no longer held (ISS-1421 r21).
 */
export async function softDeleteConnection(id: string): Promise<void> {
  await db
    .update(integrationConnections)
    .set({
      active: false,
      secretsEnc: null,
      lastHealthStatus: null,
      lastHealthDetail: null,
      lastHealthAt: null,
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, id));
}

/** A refused create's connection was never anyone's, so it goes whole (ISS-1421 r32). */
export async function deleteConnectionOfRefusedCreate(id: string): Promise<void> {
  await db.delete(integrationConnections).where(eq(integrationConnections.id, id));
}

/**
 * What a fresh install turns back on instead of standing a second connection beside it: the
 * keyless, switched-off connection `owner` holds that this project's service binding still names.
 */
export async function removedConnectionBoundTo(
  projectId: string,
  provider: IntegrationProvider,
  owner: { ownerType: 'user' | 'org'; ownerId: string },
): Promise<BindingWithConnection | null> {
  const [pair] = await db
    .select({ binding: integrationBindings, connection: integrationConnections })
    .from(integrationBindings)
    .innerJoin(
      integrationConnections,
      eq(integrationBindings.connectionId, integrationConnections.id),
    )
    .where(
      and(
        eq(integrationBindings.projectId, projectId),
        eq(integrationBindings.provider, provider),
        eq(integrationBindings.role, 'service'),
        eq(integrationConnections.active, false),
        isNull(integrationConnections.secretsEnc),
        eq(integrationConnections.ownerType, owner.ownerType),
        eq(integrationConnections.ownerId, owner.ownerId),
      ),
    )
    .orderBy(desc(integrationBindings.active), desc(integrationBindings.createdAt))
    .limit(1);
  return pair ?? null;
}

/** The order a removed GitHub connection is chosen in: the binding switched on, then the newest. */
export function switchedOnThenNewest(a: BindingWithConnection, b: BindingWithConnection): number {
  if (a.binding.active !== b.binding.active) return a.binding.active ? -1 : 1;
  return b.binding.createdAt.getTime() - a.binding.createdAt.getTime();
}

export async function softDeleteBinding(id: string): Promise<void> {
  await db
    .update(integrationBindings)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(integrationBindings.id, id));
}

export interface UpdateBindingPatch {
  config?: Record<string, unknown>;
  integrationSecret?: string | null;
  active?: boolean;
  label?: string;
  instructions?: string | null;
  agentAccess?: AgentAccess;
  /** `deploy` only, and never empty there — the DB check refuses the other shapes. */
  stages?: DeployStage[];
}

export async function updateBinding(
  id: string,
  patch: UpdateBindingPatch,
): Promise<IntegrationBindingRow | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.config !== undefined) set.config = patch.config;
  if (patch.integrationSecret !== undefined) set.integrationSecret = patch.integrationSecret;
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.instructions !== undefined) set.instructions = patch.instructions;
  if (patch.agentAccess !== undefined) set.agentAccess = patch.agentAccess;
  if (patch.stages !== undefined) set.stages = patch.stages;
  const [row] = await db
    .update(integrationBindings)
    .set(set)
    .where(eq(integrationBindings.id, id))
    .returning();
  return row ?? null;
}

/** A single binding (+ its connection) by binding id, regardless of active state. */
export async function findBindingWithConnectionById(
  id: string,
): Promise<BindingWithConnection | null> {
  const rows = await db
    .select({ binding: integrationBindings, connection: integrationConnections })
    .from(integrationBindings)
    .innerJoin(
      integrationConnections,
      eq(integrationBindings.connectionId, integrationConnections.id),
    )
    .where(eq(integrationBindings.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** All bindings (+ connections) for a project, any active state, newest first. */
export async function listBindingsForProject(projectId: string): Promise<BindingWithConnection[]> {
  return db
    .select({ binding: integrationBindings, connection: integrationConnections })
    .from(integrationBindings)
    .innerJoin(
      integrationConnections,
      eq(integrationBindings.connectionId, integrationConnections.id),
    )
    .where(eq(integrationBindings.projectId, projectId))
    .orderBy(desc(integrationBindings.createdAt));
}

/**
 * Bindings of MANY connections in one round trip, keyed by connection id.
 * Connection rows only, no join: the directory already holds the connections
 * it asked about.
 */
export async function listBindingsByConnectionIds(
  connectionIds: string[],
): Promise<Map<string, IntegrationBindingRow[]>> {
  const out = new Map<string, IntegrationBindingRow[]>();
  if (connectionIds.length === 0) return out;
  const rows = await db
    .select()
    .from(integrationBindings)
    .where(inArray(integrationBindings.connectionId, connectionIds))
    .orderBy(desc(integrationBindings.createdAt));
  for (const row of rows) {
    const list = out.get(row.connectionId);
    if (list) list.push(row);
    else out.set(row.connectionId, [row]);
  }
  return out;
}

export async function listBindingsForConnection(
  connectionId: string,
): Promise<BindingWithConnection[]> {
  return db
    .select({ binding: integrationBindings, connection: integrationConnections })
    .from(integrationBindings)
    .innerJoin(
      integrationConnections,
      eq(integrationBindings.connectionId, integrationConnections.id),
    )
    .where(eq(integrationBindings.connectionId, connectionId))
    .orderBy(desc(integrationBindings.createdAt));
}
