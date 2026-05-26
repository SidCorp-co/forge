import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IntegrationEnvironment,
  projectIntegrations,
} from '../db/schema.js';
import { decryptJson, encryptJson } from './vault.js';
import type { AdapterContext, IntegrationProvider } from './types.js';

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
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.provider, provider),
      ),
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

export function buildContext<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
>(row: ProjectIntegrationRow): AdapterContext<TConfig, TSecrets> {
  const secrets = row.secretsEnc
    ? decryptJson<TSecrets>(row.secretsEnc)
    : ({} as TSecrets);
  return {
    integrationId: row.id,
    projectId: row.projectId,
    provider: row.provider as IntegrationProvider,
    environment: row.environment as IntegrationEnvironment,
    config: (row.config ?? {}) as TConfig,
    secrets,
    integrationSecret: row.integrationSecret,
  };
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
