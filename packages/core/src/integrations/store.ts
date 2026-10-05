import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import {
  type BindingRole,
  type IntegrationOwnerType,
  integrationBindings,
  integrationConnections,
  type ObservedEndpoint,
  organizationMembers,
} from '../db/schema.js';
import { getIntegration } from './registry.js';
import type { AdapterContext, IntegrationProvider } from './types.js';
import { decryptJson, decryptSecret, encryptJson } from './vault.js';

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

async function listActivePairs(
  projectId: string,
  provider: IntegrationProvider,
  role?: BindingRole,
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
        role ? eq(integrationBindings.role, role) : undefined,
        eq(integrationBindings.active, true),
        eq(integrationConnections.active, true),
      ),
    )
    .orderBy(asc(integrationBindings.createdAt));
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
  return listActivePairs(projectId, provider, 'deploy');
}

/**
 * All active bindings (+ connections) for a project + provider, across roles. Used by the inbound
 * webhook router to find the right binding when the payload carries a provider hint.
 */
export async function listActiveBindingsForProjectProvider(
  projectId: string,
  provider: IntegrationProvider,
): Promise<BindingWithConnection[]> {
  return listActivePairs(projectId, provider);
}

/** Decrypt a connection's secrets blob, or `{}` when it has none. */
export function decryptConnectionSecrets<
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
>(connection: IntegrationConnectionRow): TSecrets {
  return connection.secretsEnc ? decryptJson<TSecrets>(connection.secretsEnc) : ({} as TSecrets);
}

/**
 * Effective config for a dispatch = connection.config overlaid with binding.config. A key the
 * provider declares the binding's alone (Coolify's deploy `targets`) is never read off the
 * connection: one stored there from before the split is not every project's target.
 */
export function effectiveConfig<TConfig extends Record<string, unknown> = Record<string, unknown>>(
  pair: BindingWithConnection,
): TConfig {
  const bindingOnly = new Set<string>(
    getIntegration(pair.binding.provider)?.schemas.bindingOnlyConfigKeys ?? [],
  );
  const shared = Object.fromEntries(
    Object.entries((pair.connection.config ?? {}) as Record<string, unknown>).filter(
      ([key]) => !bindingOnly.has(key),
    ),
  );
  return { ...shared, ...((pair.binding.config ?? {}) as object) } as TConfig;
}

/** A binding's inbound webhook secret, decrypted from the vault; null when it has none. */
export function bindingInboundSecret(binding: {
  integrationSecretEnc: Buffer | null;
}): string | null {
  return binding.integrationSecretEnc === null ? null : decryptSecret(binding.integrationSecretEnc);
}

/**
 * Build an {@link AdapterContext} from a binding+connection pair. Threads
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
    config: effectiveConfig<TConfig>(pair),
    secrets: decryptConnectionSecrets<TSecrets>(pair.connection),
    integrationSecret: bindingInboundSecret(pair.binding),
  };
}

interface CreateConnectionInput {
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

interface UpdateConnectionPatch {
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

export async function softDeleteConnection(id: string): Promise<void> {
  await db
    .update(integrationConnections)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(integrationConnections.id, id));
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

/**
 * Connections visible to a user: their own (ownerType=user) plus org-owned
 * connections of every org they belong to (any role — managing them is
 * gated separately at the route layer). Returns ALL active states — the
 * directory must show a disabled connection as Disabled (and allow
 * re-enabling it) rather than silently dropping it (ISS-429);
 * share-eligibility filtering (`active && hasSecrets`) happens client-side.
 */
export async function listConnectionsForPrincipalUser(
  userId: string,
): Promise<IntegrationConnectionRow[]> {
  const orgRows = await db
    .select({ orgId: organizationMembers.orgId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId));
  const orgIds = orgRows.map((r) => r.orgId);
  return db
    .select()
    .from(integrationConnections)
    .where(
      or(
        and(
          eq(integrationConnections.ownerType, 'user'),
          eq(integrationConnections.ownerId, userId),
        ),
        orgIds.length > 0
          ? and(
              eq(integrationConnections.ownerType, 'org'),
              inArray(integrationConnections.ownerId, orgIds),
            )
          : sql`false`,
      ),
    )
    .orderBy(desc(integrationConnections.createdAt));
}

/**
 * A connection's sealed secrets replaced, with the health reading that came with the change when
 * there is one, in the caller's transaction.
 */
export async function writeConnectionSecrets(
  tx: Tx,
  connectionId: string,
  secretsEnc: ReturnType<typeof encryptJson>,
  at: Date,
  health?: {
    status: NonNullable<(typeof integrationConnections.$inferInsert)['lastHealthStatus']>;
    detail: string;
  },
): Promise<void> {
  await tx
    .update(integrationConnections)
    .set({
      secretsEnc,
      updatedAt: at,
      ...(health
        ? { lastHealthStatus: health.status, lastHealthDetail: health.detail, lastHealthAt: at }
        : {}),
    })
    .where(eq(integrationConnections.id, connectionId));
}
