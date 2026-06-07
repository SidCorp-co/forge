import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IntegrationEnvironment,
  type IntegrationOwnerType,
  integrationBindings,
  integrationConnections,
  projectIntegrations,
} from '../db/schema.js';
import type { AdapterContext, IntegrationProvider } from './types.js';
import { decryptJson, encryptJson } from './vault.js';

export type ProjectIntegrationRow = typeof projectIntegrations.$inferSelect;

/** Returns the active integration row for a project + provider + environment. */
export async function findActive(
  projectId: string,
  provider: IntegrationProvider,
  environment: IntegrationEnvironment,
): Promise<ProjectIntegrationRow | null> {
  const rows = await db
    .select()
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.provider, provider),
        eq(projectIntegrations.environment, environment),
        eq(projectIntegrations.active, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Loads ALL integrations for a project + provider (across environments).
 * Used by the inbound webhook router to find the right one to dispatch to
 * when the payload carries the environment hint (Coolify webhook embeds it).
 */
export async function listForProjectProvider(
  projectId: string,
  provider: IntegrationProvider,
): Promise<ProjectIntegrationRow[]> {
  return db
    .select()
    .from(projectIntegrations)
    .where(
      and(eq(projectIntegrations.projectId, projectId), eq(projectIntegrations.provider, provider)),
    );
}

export async function findById(id: string): Promise<ProjectIntegrationRow | null> {
  const rows = await db
    .select()
    .from(projectIntegrations)
    .where(eq(projectIntegrations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export interface UpsertIntegrationInput {
  projectId: string;
  provider: IntegrationProvider;
  environment: IntegrationEnvironment;
  config: Record<string, unknown>;
  secrets?: Record<string, unknown> | null;
  integrationSecret?: string | null;
}

export async function createIntegration(
  input: UpsertIntegrationInput,
): Promise<ProjectIntegrationRow> {
  const secretsEnc = input.secrets ? encryptJson(input.secrets) : null;
  const [row] = await db
    .insert(projectIntegrations)
    .values({
      projectId: input.projectId,
      provider: input.provider,
      environment: input.environment,
      config: input.config,
      secretsEnc,
      integrationSecret: input.integrationSecret ?? null,
      active: true,
    })
    .returning();
  if (!row) throw new Error('createIntegration: insert returned no row');
  return row;
}

export interface UpdateIntegrationPatch {
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown> | null;
  integrationSecret?: string | null;
  active?: boolean;
  lastHealthStatus?: string | null;
  lastHealthAt?: Date | null;
  breakerOpenedAt?: Date | null;
}

export async function updateIntegration(
  id: string,
  patch: UpdateIntegrationPatch,
): Promise<ProjectIntegrationRow | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.config !== undefined) set.config = patch.config;
  if (patch.secrets !== undefined) {
    set.secretsEnc = patch.secrets ? encryptJson(patch.secrets) : null;
  }
  if (patch.integrationSecret !== undefined) set.integrationSecret = patch.integrationSecret;
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.lastHealthStatus !== undefined) set.lastHealthStatus = patch.lastHealthStatus;
  if (patch.lastHealthAt !== undefined) set.lastHealthAt = patch.lastHealthAt;
  if (patch.breakerOpenedAt !== undefined) set.breakerOpenedAt = patch.breakerOpenedAt;
  const [row] = await db
    .update(projectIntegrations)
    .set(set)
    .where(eq(projectIntegrations.id, id))
    .returning();
  return row ?? null;
}

export async function softDeleteIntegration(id: string): Promise<void> {
  await db
    .update(projectIntegrations)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(projectIntegrations.id, id));
}

// === Connection / Binding model (docs/integrations/connection-binding.md) ===
//
// Reads + CRUD over the additive successor tables. The REST cutover issue
// consumes these to repoint resolvers / MCP tools / inbound router off
// project_integrations. Nothing in core reads these yet, so they are inert and
// safe to land.

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
}

export async function updateBinding(
  id: string,
  patch: UpdateBindingPatch,
): Promise<IntegrationBindingRow | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.config !== undefined) set.config = patch.config;
  if (patch.integrationSecret !== undefined) set.integrationSecret = patch.integrationSecret;
  if (patch.active !== undefined) set.active = patch.active;
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

/** Connections owned by a principal (owner-scoped CRUD list). */
export async function listConnectionsForOwner(
  ownerId: string,
): Promise<IntegrationConnectionRow[]> {
  return db
    .select()
    .from(integrationConnections)
    .where(and(eq(integrationConnections.ownerId, ownerId), eq(integrationConnections.active, true)))
    .orderBy(desc(integrationConnections.createdAt));
}
