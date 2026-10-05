import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { AgentAccess, BindingRole } from '../db/release-axes.js';
import { integrationBindings, integrationConnections } from '../db/schema.js';
import { encryptSecret, isVaultConfigured } from '../integrations/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { projectOrgOf } from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { actorFor, can, orgResource } from '../permissions/index.js';

export interface StoredBinding {
  id: string;
  projectId: string;
  connectionId: string;
  provider: string;
  role: BindingRole;
  config: unknown;
  label: string;
  agentAccess: AgentAccess;
  active: boolean;
  instructions: string | null;
  revision: number;
}

interface ConnectionFacts {
  id: string;
  provider: string;
  ownerType: 'user' | 'org';
  ownerId: string;
  active: boolean;
}

interface BindingWrite {
  id: string;
  projectId: string;
  connectionId: string;
  provider: string;
  role: BindingRole;
  config: Record<string, unknown>;
  label: string;
  agentAccess: AgentAccess;
  active: boolean;
  instructions: string | null;
}

type BindingCasResult =
  | { ok: true; stored: StoredBinding; created: boolean; changed: boolean }
  | { ok: false; reason: 'stale'; storedRevision: number | null }
  | { ok: false; reason: 'foreign' }
  | { ok: false; reason: 'service-clash' };

const bindingColumns = {
  id: integrationBindings.id,
  projectId: integrationBindings.projectId,
  connectionId: integrationBindings.connectionId,
  provider: integrationBindings.provider,
  role: integrationBindings.role,
  config: integrationBindings.config,
  label: integrationBindings.label,
  agentAccess: integrationBindings.agentAccess,
  active: integrationBindings.active,
  instructions: integrationBindings.instructions,
  revision: integrationBindings.revision,
};

export const drizzleBindingStore = {
  async readBinding(id: string): Promise<StoredBinding | null> {
    const [row] = await db
      .select(bindingColumns)
      .from(integrationBindings)
      .where(eq(integrationBindings.id, id))
      .limit(1);
    return row ?? null;
  },

  async listProjectBindings(projectId: string): Promise<StoredBinding[]> {
    return db
      .select(bindingColumns)
      .from(integrationBindings)
      .where(eq(integrationBindings.projectId, projectId))
      .orderBy(integrationBindings.createdAt);
  },

  async readConnection(id: string): Promise<ConnectionFacts | null> {
    const [row] = await db
      .select({
        id: integrationConnections.id,
        provider: integrationConnections.provider,
        ownerType: integrationConnections.ownerType,
        ownerId: integrationConnections.ownerId,
        active: integrationConnections.active,
      })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id))
      .limit(1);
    return row ?? null;
  },

  projectOrgId: projectOrgOf,

  async isOrgAdmin(orgId: string, userId: string): Promise<boolean> {
    return can(actorFor(userId), 'org.admin', orgResource(orgId));
  },

  async casBinding({
    baseRevision,
    integrationSecret,
    ...write
  }: BindingWrite & {
    baseRevision: number | null;
    integrationSecret: () => Promise<string>;
  }): Promise<BindingCasResult> {
    try {
      return await db.transaction(async (tx) => {
        await lockXact(tx, 'projectConfigBinding', write.id);
        const [current] = await tx
          .select(bindingColumns)
          .from(integrationBindings)
          .where(eq(integrationBindings.id, write.id))
          .limit(1);
        if (current && current.projectId !== write.projectId) {
          return { ok: false as const, reason: 'foreign' as const };
        }
        const storedRevision = current?.revision ?? null;
        if (storedRevision !== baseRevision) {
          return { ok: false as const, reason: 'stale' as const, storedRevision };
        }
        const values = {
          connectionId: write.connectionId,
          provider: write.provider,
          role: write.role,
          config: write.config,
          label: write.label,
          agentAccess: write.agentAccess,
          active: write.active,
          instructions: write.instructions,
        };
        if (
          current &&
          current.active === values.active &&
          current.instructions === values.instructions &&
          current.connectionId === values.connectionId &&
          current.provider === values.provider &&
          current.role === values.role &&
          current.label === values.label &&
          current.agentAccess === values.agentAccess &&
          JSON.stringify(current.config) === JSON.stringify(values.config)
        ) {
          return { ok: true as const, stored: current, created: false, changed: false };
        }
        const [row] = current
          ? await tx
              .update(integrationBindings)
              .set({ ...values, updatedAt: new Date() })
              .where(eq(integrationBindings.id, write.id))
              .returning(bindingColumns)
          : await tx
              .insert(integrationBindings)
              .values({
                id: write.id,
                projectId: write.projectId,
                integrationSecretEnc: encryptSecret(await integrationSecret()),
                ...values,
              })
              .returning(bindingColumns);
        if (!row) throw new Error('project-config: binding write returned no row');
        return { ok: true as const, stored: row, created: !current, changed: true };
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, reason: 'service-clash' };
      throw err;
    }
  },
};

/** A binding's inbound webhook secret, rotated. */
export async function setBindingInboundSecret(
  id: string,
  integrationSecret: string,
): Promise<typeof integrationBindings.$inferSelect | null> {
  const [row] = await db
    .update(integrationBindings)
    .set({ integrationSecretEnc: encryptSecret(integrationSecret), updatedAt: new Date() })
    .where(eq(integrationBindings.id, id))
    .returning();
  return row ?? null;
}

/**
 * Boot: every inbound webhook secret still resting as plaintext (written before 0404) is encrypted
 * with the integration vault and its plaintext nulled. Refuses to boot, naming the key, when such a
 * row exists and no INTEGRATION_MASTER_KEY is set. Returns how many rows it converted.
 */
export async function encryptPlaintextBindingSecrets(): Promise<number> {
  const rows = await db
    .select({ id: integrationBindings.id, plain: integrationBindings.integrationSecretPlain })
    .from(integrationBindings)
    .where(isNotNull(integrationBindings.integrationSecretPlain));
  if (rows.length === 0) return 0;
  if (!isVaultConfigured()) {
    throw new Error(
      `INTEGRATION_MASTER_KEY is not set but ${rows.length} integration_bindings row(s) hold a plaintext inbound webhook secret. Refusing to boot: set INTEGRATION_MASTER_KEY so core can encrypt them.`,
    );
  }
  for (const row of rows) {
    if (row.plain === null) continue;
    await db
      .update(integrationBindings)
      .set({ integrationSecretEnc: encryptSecret(row.plain), integrationSecretPlain: null })
      .where(
        and(
          eq(integrationBindings.id, row.id),
          isNotNull(integrationBindings.integrationSecretPlain),
        ),
      );
  }
  return rows.length;
}
