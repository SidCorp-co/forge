import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { BindingRole } from '../db/release-axes.js';
import { integrationBindings, projects, runners } from '../db/schema.js';
import {
  projectConfigDocuments,
  projectConfigRevisions,
  projectPolicies,
  projectSecrets,
  projectTestingProfiles,
} from '../db/schema-project-config.js';
import { parseSecretRef, secretRefOf } from './documents.js';

export interface StoredDocument {
  revision: number;
  document: unknown;
  updatedBy: string;
  updatedAt: Date;
}

export interface StoredRevision {
  revision: number;
  document: unknown;
  writtenBy: string;
  writtenAt: Date;
}

export interface StoredProfile extends StoredDocument {
  profileId: string;
}

export interface BindingRow {
  id: string;
  role: BindingRole;
  provider: string;
  label: string;
}

export interface SecretName {
  scope: string;
  name: string;
  updatedAt: Date;
}

export interface DeviceCheckout {
  deviceId: string;
  repoPath: string | null;
  branch: string | null;
}

export type CasResult =
  | { ok: true; stored: StoredDocument; created: boolean }
  | { ok: false; storedRevision: number | null };

export interface CasInput {
  projectId: string;
  baseRevision: number | null;
  document: unknown;
  userId: string;
}

export interface ConfigStore {
  readProject(projectId: string): Promise<StoredDocument | null>;
  listProjectRevisions(projectId: string): Promise<StoredRevision[]>;
  casProject(input: CasInput): Promise<CasResult>;
  readPolicy(projectId: string): Promise<StoredDocument | null>;
  casPolicy(input: CasInput): Promise<CasResult>;
  listTestingProfiles(projectId: string): Promise<StoredProfile[]>;
  readTestingProfile(projectId: string, profileId: string): Promise<StoredDocument | null>;
  casTestingProfile(input: CasInput & { profileId: string }): Promise<CasResult>;
  deleteTestingProfile(projectId: string, profileId: string): Promise<boolean>;
  listActiveBindings(projectId: string): Promise<BindingRow[]>;
  slugTakenBy(projectId: string, slug: string): Promise<string | null>;
  listSecretNames(projectId: string): Promise<SecretName[]>;
  existingSecretRefs(projectId: string, refs: readonly string[]): Promise<Set<string>>;
  putSecret(input: {
    projectId: string;
    scope: string;
    name: string;
    valueEnc: Buffer;
  }): Promise<SecretName>;
  deviceCheckout(projectId: string, deviceId: string): Promise<DeviceCheckout | null>;
  readSecret(projectId: string, scope: string, name: string): Promise<Buffer | null>;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const lockKey = (kind: string, projectId: string, extra = '') =>
  sql`SELECT pg_advisory_xact_lock(hashtextextended(${`project-config:${kind}:${projectId}:${extra}`}, 0))`;

export const drizzleConfigStore: ConfigStore = {
  async readProject(projectId) {
    const [row] = await db
      .select()
      .from(projectConfigDocuments)
      .where(eq(projectConfigDocuments.projectId, projectId))
      .limit(1);
    return row ?? null;
  },

  async listProjectRevisions(projectId) {
    return db
      .select({
        revision: projectConfigRevisions.revision,
        document: projectConfigRevisions.document,
        writtenBy: projectConfigRevisions.writtenBy,
        writtenAt: projectConfigRevisions.writtenAt,
      })
      .from(projectConfigRevisions)
      .where(eq(projectConfigRevisions.projectId, projectId))
      .orderBy(desc(projectConfigRevisions.revision));
  },

  async casProject({ projectId, baseRevision, document, userId }) {
    return db.transaction(async (tx) => {
      await tx.execute(lockKey('project', projectId));
      const [current] = await tx
        .select()
        .from(projectConfigDocuments)
        .where(eq(projectConfigDocuments.projectId, projectId))
        .limit(1);
      const storedRevision = current?.revision ?? null;
      if (storedRevision !== baseRevision) return { ok: false, storedRevision };
      if (current && sameJson(current.document, document)) {
        return { ok: true, stored: current, created: false };
      }
      const revision = (storedRevision ?? 0) + 1;
      const now = new Date();
      const [row] = await tx
        .insert(projectConfigDocuments)
        .values({ projectId, revision, document, updatedBy: userId, updatedAt: now })
        .onConflictDoUpdate({
          target: projectConfigDocuments.projectId,
          set: { revision, document, updatedBy: userId, updatedAt: now },
        })
        .returning();
      await tx
        .insert(projectConfigRevisions)
        .values({ projectId, revision, document, writtenBy: userId, writtenAt: now });
      if (!row) throw new Error('project-config: document upsert returned no row');
      return { ok: true, stored: row, created: true };
    });
  },

  async readPolicy(projectId) {
    const [row] = await db
      .select()
      .from(projectPolicies)
      .where(eq(projectPolicies.projectId, projectId))
      .limit(1);
    return row ?? null;
  },

  async casPolicy({ projectId, baseRevision, document, userId }) {
    return db.transaction(async (tx) => {
      await tx.execute(lockKey('policy', projectId));
      const [current] = await tx
        .select()
        .from(projectPolicies)
        .where(eq(projectPolicies.projectId, projectId))
        .limit(1);
      const storedRevision = current?.revision ?? null;
      if (storedRevision !== baseRevision) return { ok: false, storedRevision };
      if (current && sameJson(current.document, document)) {
        return { ok: true, stored: current, created: false };
      }
      const revision = (storedRevision ?? 0) + 1;
      const now = new Date();
      const [row] = await tx
        .insert(projectPolicies)
        .values({ projectId, revision, document, updatedBy: userId, updatedAt: now })
        .onConflictDoUpdate({
          target: projectPolicies.projectId,
          set: { revision, document, updatedBy: userId, updatedAt: now },
        })
        .returning();
      if (!row) throw new Error('project-config: policy upsert returned no row');
      return { ok: true, stored: row, created: true };
    });
  },

  async listTestingProfiles(projectId) {
    return db
      .select()
      .from(projectTestingProfiles)
      .where(eq(projectTestingProfiles.projectId, projectId))
      .orderBy(projectTestingProfiles.profileId);
  },

  async readTestingProfile(projectId, profileId) {
    const [row] = await db
      .select()
      .from(projectTestingProfiles)
      .where(
        and(
          eq(projectTestingProfiles.projectId, projectId),
          eq(projectTestingProfiles.profileId, profileId),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async casTestingProfile({ projectId, profileId, baseRevision, document, userId }) {
    return db.transaction(async (tx) => {
      await tx.execute(lockKey('testing-profile', projectId, profileId));
      const where = and(
        eq(projectTestingProfiles.projectId, projectId),
        eq(projectTestingProfiles.profileId, profileId),
      );
      const [current] = await tx.select().from(projectTestingProfiles).where(where).limit(1);
      const storedRevision = current?.revision ?? null;
      if (storedRevision !== baseRevision) return { ok: false, storedRevision };
      if (current && sameJson(current.document, document)) {
        return { ok: true, stored: current, created: false };
      }
      const revision = (storedRevision ?? 0) + 1;
      const now = new Date();
      const [row] = await tx
        .insert(projectTestingProfiles)
        .values({ projectId, profileId, revision, document, updatedBy: userId, updatedAt: now })
        .onConflictDoUpdate({
          target: [projectTestingProfiles.projectId, projectTestingProfiles.profileId],
          set: { revision, document, updatedBy: userId, updatedAt: now },
        })
        .returning();
      if (!row) throw new Error('project-config: testing profile upsert returned no row');
      return { ok: true, stored: row, created: true };
    });
  },

  async deleteTestingProfile(projectId, profileId) {
    const rows = await db
      .delete(projectTestingProfiles)
      .where(
        and(
          eq(projectTestingProfiles.projectId, projectId),
          eq(projectTestingProfiles.profileId, profileId),
        ),
      )
      .returning({ profileId: projectTestingProfiles.profileId });
    return rows.length > 0;
  },

  async listActiveBindings(projectId) {
    return db
      .select({
        id: integrationBindings.id,
        role: integrationBindings.role,
        provider: integrationBindings.provider,
        label: integrationBindings.label,
      })
      .from(integrationBindings)
      .where(
        and(eq(integrationBindings.projectId, projectId), eq(integrationBindings.active, true)),
      );
  },

  async slugTakenBy(projectId, slug) {
    const [byColumn] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.slug, slug), ne(projects.id, projectId)))
      .limit(1);
    if (byColumn) return byColumn.id;
    const [byDocument] = await db
      .select({ id: projectConfigDocuments.projectId })
      .from(projectConfigDocuments)
      .where(
        and(
          sql`${projectConfigDocuments.document} #>> '{project,slug}' = ${slug}`,
          ne(projectConfigDocuments.projectId, projectId),
        ),
      )
      .limit(1);
    return byDocument?.id ?? null;
  },

  async listSecretNames(projectId) {
    return db
      .select({
        scope: projectSecrets.scope,
        name: projectSecrets.name,
        updatedAt: projectSecrets.updatedAt,
      })
      .from(projectSecrets)
      .where(eq(projectSecrets.projectId, projectId))
      .orderBy(projectSecrets.scope, projectSecrets.name);
  },

  async existingSecretRefs(projectId, refs) {
    const wanted = refs.map(parseSecretRef).filter((r) => r !== null);
    if (wanted.length === 0) return new Set();
    const rows = await db
      .select({ scope: projectSecrets.scope, name: projectSecrets.name })
      .from(projectSecrets)
      .where(
        and(
          eq(projectSecrets.projectId, projectId),
          inArray(
            projectSecrets.scope,
            wanted.map((w) => w.scope),
          ),
        ),
      );
    return new Set(rows.map((r) => secretRefOf(r.scope, r.name)));
  },

  async readSecret(projectId, scope, name) {
    const [row] = await db
      .select({ enc: projectSecrets.valueEnc })
      .from(projectSecrets)
      .where(
        and(
          eq(projectSecrets.projectId, projectId),
          eq(projectSecrets.scope, scope),
          eq(projectSecrets.name, name),
        ),
      )
      .limit(1);
    return row?.enc ?? null;
  },

  async putSecret({ projectId, scope, name, valueEnc }) {
    const now = new Date();
    const [row] = await db
      .insert(projectSecrets)
      .values({ projectId, scope, name, valueEnc, updatedAt: now })
      .onConflictDoUpdate({
        target: [projectSecrets.projectId, projectSecrets.scope, projectSecrets.name],
        set: { valueEnc, updatedAt: now },
      })
      .returning({
        scope: projectSecrets.scope,
        name: projectSecrets.name,
        updatedAt: projectSecrets.updatedAt,
      });
    if (!row) throw new Error('project-config: secret upsert returned no row');
    return row;
  },

  async deviceCheckout(projectId, deviceId) {
    const [row] = await db
      .select({ deviceId: runners.deviceId, repoPath: runners.repoPath, branch: runners.branch })
      .from(runners)
      .where(
        and(
          eq(runners.projectId, projectId),
          eq(runners.deviceId, deviceId),
          eq(runners.type, 'claude-code'),
        ),
      )
      .limit(1);
    return row ?? null;
  },
};
