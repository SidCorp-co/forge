import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IntegrationEnvironment,
  type IntegrationOwnerType,
  integrationBindings,
  integrationConnections,
  organizationMembers,
} from '../db/schema.js';
import type { AdapterContext, IntegrationProvider } from './types.js';
import { decryptJson, encryptJson } from './vault.js';

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
 * ISS-558 — Active epodsystem binding for a specific label slot.
 * label='' targets the default/unlabeled binding; a non-empty label targets
 * a named extra binding. Used by the create-guard for epodsystem only.
 */
export async function findActiveBindingByLabel(
  projectId: string,
  provider: IntegrationProvider,
  environment: IntegrationEnvironment,
  label: string,
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
        eq(integrationBindings.environment, environment),
        eq(integrationBindings.label, label),
        eq(integrationBindings.active, true),
        eq(integrationConnections.active, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Active binding (+ its connection) for a project + provider + environment. */
export async function findActiveBinding(
  projectId: string,
  provider: IntegrationProvider,
  environment: IntegrationEnvironment,
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
        eq(integrationBindings.environment, environment),
        eq(integrationBindings.active, true),
        eq(integrationConnections.active, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * All active bindings (+ connections) for a project + provider, across
 * environments. Used by the inbound webhook router to find the right binding
 * when the payload carries the environment hint.
 */
export async function listActiveBindingsForProjectProvider(
  projectId: string,
  provider: IntegrationProvider,
): Promise<BindingWithConnection[]> {
  return (
    db
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
      // cm:guard never drop this ORDER BY — the MCP resolvers inject row [0] into the single `mcpServers.<provider>` slot, so an unordered pick lets a newly added second binding silently flip which credential agents receive (ISS-431); mcp-preview's `shadowed` reason mirrors oldest-first
      .orderBy(asc(integrationBindings.createdAt))
  );
}

/**
 * Every active binding for a project in one environment, across ALL providers.
 * The release path asks "what ships this project", which is a question about
 * the environment rather than about any one provider.
 */
export async function listActiveBindingsForEnvironment(
  projectId: string,
  environment: IntegrationEnvironment,
): Promise<BindingWithConnection[]> {
  return (
    db
      .select({ binding: integrationBindings, connection: integrationConnections })
      .from(integrationBindings)
      .innerJoin(
        integrationConnections,
        eq(integrationBindings.connectionId, integrationConnections.id),
      )
      .where(
        and(
          eq(integrationBindings.projectId, projectId),
          eq(integrationBindings.environment, environment),
          eq(integrationBindings.active, true),
          eq(integrationConnections.active, true),
        ),
      )
      // cm:edge protocol -> packages/core/src/integrations/store.ts — same oldest-first rule as listActiveBindingsForProjectProvider, and for the same reason: a caller that injects row [0] must not have its pick flipped by adding a second binding
      .orderBy(asc(integrationBindings.createdAt))
  );
}

/** Decrypt a connection's secrets blob, or `{}` when it has none. */
export function decryptConnectionSecrets<
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
>(connection: IntegrationConnectionRow): TSecrets {
  return connection.secretsEnc ? decryptJson<TSecrets>(connection.secretsEnc) : ({} as TSecrets);
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
    environment: pair.binding.environment as IntegrationEnvironment,
    config: effectiveConfig<TConfig>(pair),
    secrets: decryptConnectionSecrets<TSecrets>(pair.connection),
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
  lastHealthAt?: Date | null;
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
  if (patch.lastHealthAt !== undefined) set.lastHealthAt = patch.lastHealthAt;
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
  environment: IntegrationEnvironment;
  config?: Record<string, unknown>;
  integrationSecret?: string | null;
  /** ISS-558 — empty string (default) = unlabeled/default binding;
   *  non-empty kebab = a named extra epodsystem binding. */
  label?: string;
}

export async function createBinding(input: CreateBindingInput): Promise<IntegrationBindingRow> {
  const [row] = await db
    .insert(integrationBindings)
    .values({
      connectionId: input.connectionId,
      projectId: input.projectId,
      provider: input.provider,
      environment: input.environment,
      config: input.config ?? {},
      integrationSecret: input.integrationSecret ?? null,
      label: input.label ?? '',
      active: true,
    })
    .returning();
  if (!row) throw new Error('createBinding: insert returned no row');
  return row;
}

export async function softDeleteConnection(id: string): Promise<void> {
  await db
    .update(integrationConnections)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(integrationConnections.id, id));
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
// cm:guard one query for the whole page, never one per card — the connections directory renders every credential a principal can see (17 on forge-beta today), and a per-card fetch is an N+1 that also arrives out of order
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

/** All bindings (+ connections) for one connection, any active state, newest first. */
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
