import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { BindingRole } from '../db/release-axes.js';
import { integrationBindings, integrationConnections, projects } from '../db/schema.js';
import { loadOrgRole, orgRoleAtLeast } from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';

export interface StoredBinding {
  id: string;
  projectId: string;
  connectionId: string;
  provider: string;
  role: BindingRole;
  stages: string[];
  config: unknown;
  active: boolean;
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
  stages: string[];
  config: Record<string, unknown>;
}

export type BindingCasResult =
  | { ok: true; stored: StoredBinding; created: boolean }
  | { ok: false; reason: 'stale'; storedRevision: number | null }
  | { ok: false; reason: 'foreign' }
  | { ok: false; reason: 'service-clash' };

export interface BindingStore {
  readBinding(id: string): Promise<StoredBinding | null>;
  listProjectBindings(projectId: string): Promise<StoredBinding[]>;
  readConnection(id: string): Promise<ConnectionFacts | null>;
  projectOrgId(projectId: string): Promise<string | null>;
  isOrgAdmin(orgId: string, userId: string): Promise<boolean>;
  casBinding(input: BindingWrite & { baseRevision: number | null }): Promise<BindingCasResult>;
}

const bindingColumns = {
  id: integrationBindings.id,
  projectId: integrationBindings.projectId,
  connectionId: integrationBindings.connectionId,
  provider: integrationBindings.provider,
  role: integrationBindings.role,
  stages: integrationBindings.stages,
  config: integrationBindings.config,
  active: integrationBindings.active,
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

  async projectOrgId(projectId) {
    const [row] = await db
      .select({ orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return row?.orgId ?? null;
  },

  async isOrgAdmin(orgId, userId) {
    return orgRoleAtLeast(await loadOrgRole(orgId, userId), 'admin');
  },

  async casBinding({ baseRevision, ...write }) {
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
          stages: write.stages,
          config: write.config,
          active: true,
        };
        if (
          current?.active &&
          current.connectionId === values.connectionId &&
          current.provider === values.provider &&
          current.role === values.role &&
          JSON.stringify(current.stages) === JSON.stringify(values.stages) &&
          JSON.stringify(current.config) === JSON.stringify(values.config)
        ) {
          return { ok: true as const, stored: current, created: false };
        }
        const [row] = current
          ? await tx
              .update(integrationBindings)
              .set({ ...values, updatedAt: new Date() })
              .where(eq(integrationBindings.id, write.id))
              .returning(bindingColumns)
          : await tx
              .insert(integrationBindings)
              .values({ id: write.id, projectId: write.projectId, ...values })
              .returning(bindingColumns);
        if (!row) throw new Error('project-config: binding write returned no row');
        return { ok: true as const, stored: row, created: true };
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, reason: 'service-clash' };
      throw err;
    }
  },
};
