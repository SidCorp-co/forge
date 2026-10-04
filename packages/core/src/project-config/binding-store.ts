import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { AgentAccess, BindingRole } from '../db/release-axes.js';
import { integrationBindings, integrationConnections } from '../db/schema.js';
import { loadOrgRole } from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { findProjectOrgId } from '../projects/service.js';
import { holdsOrg } from '../permissions/index.js';

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

export interface ConnectionFacts {
  id: string;
  provider: string;
  ownerType: 'user' | 'org';
  ownerId: string;
  active: boolean;
}

export interface BindingWrite {
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

export type BindingCasResult =
  | { ok: true; stored: StoredBinding; created: boolean; changed: boolean }
  | { ok: false; reason: 'stale'; storedRevision: number | null }
  | { ok: false; reason: 'foreign' }
  | { ok: false; reason: 'service-clash' };

export interface BindingStore {
  readBinding(id: string): Promise<StoredBinding | null>;
  listProjectBindings(projectId: string): Promise<StoredBinding[]>;
  readConnection(id: string): Promise<ConnectionFacts | null>;
  projectOrgId(projectId: string): Promise<string | null>;
  isOrgAdmin(orgId: string, userId: string): Promise<boolean>;
  casBinding(
    input: BindingWrite & { baseRevision: number | null; integrationSecret: () => Promise<string> },
  ): Promise<BindingCasResult>;
}

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

export const drizzleBindingStore: BindingStore = {
  async readBinding(id) {
    const [row] = await db
      .select(bindingColumns)
      .from(integrationBindings)
      .where(eq(integrationBindings.id, id))
      .limit(1);
    return row ?? null;
  },

  async listProjectBindings(projectId) {
    return db
      .select(bindingColumns)
      .from(integrationBindings)
      .where(eq(integrationBindings.projectId, projectId))
      .orderBy(integrationBindings.createdAt);
  },

  async readConnection(id) {
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

  projectOrgId: findProjectOrgId,

  async isOrgAdmin(orgId, userId) {
    return holdsOrg(await loadOrgRole(orgId, userId), 'org.admin');
  },

  async casBinding({ baseRevision, integrationSecret, ...write }) {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`project-config:binding:${write.id}`}, 0))`,
        );
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
                integrationSecret: await integrationSecret(),
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
    .set({ integrationSecret, updatedAt: new Date() })
    .where(eq(integrationBindings.id, id))
    .returning();
  return row ?? null;
}
