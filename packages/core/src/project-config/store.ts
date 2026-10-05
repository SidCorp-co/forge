import { parseSecretRef, secretRefOf } from '@forge/contracts/project-config';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import type { BindingRole } from '../db/release-axes.js';
import { integrationBindings, projects, runners } from '../db/schema.js';
import {
  projectConfigDocuments,
  projectPolicies,
  projectSecrets,
  projectTestingProfiles,
} from '../db/schema-project-config.js';
import { lockXact } from '../lib/advisory-lock.js';
import { isUniqueViolation, uniqueViolationConstraint } from '../lib/db-errors.js';
import { DEFAULT_POLICY } from './default-policy.js';
import type { ApiRefusal } from './documents.js';
import { projectConfigPorts } from './ports.js';
import type { ProjectDocument } from './schema.js';

export interface StoredDocument {
  revision: number;
  document: unknown;
  updatedBy: string;
  updatedAt: Date;
}

interface StoredProfile extends StoredDocument {
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
  | { ok: false; storedRevision: number | null }
  | { ok: false; refusal: ApiRefusal };

interface CasInput {
  projectId: string;
  baseRevision: number | null;
  document: unknown;
  userId: string;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const lockConfig = (tx: Tx, kind: string, projectId: string, extra = '') =>
  lockXact(tx, 'projectConfig', `${kind}:${projectId}:${extra}`);

export const drizzleConfigStore = {
  async workflowTemplatesInUse(projectId: string): Promise<Map<string, string[]>> {
    const rows = (await db.execute(sql`
      SELECT flow, document->'template'->>'id' AS id, document->'template'->>'version' AS version
      FROM project_workflows
      WHERE project_id = ${projectId} AND document->>'version' = '2' AND document ? 'template'
    `)) as unknown as Array<{ flow: string; id: string; version: string }>;
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const key = `${r.id}@${r.version}`;
      out.set(key, [...(out.get(key) ?? []), r.flow]);
    }
    return out;
  },

  async readProject(projectId: string): Promise<StoredDocument | null> {
    const [row] = await db
      .select()
      .from(projectConfigDocuments)
      .where(eq(projectConfigDocuments.projectId, projectId))
      .limit(1);
    return row ?? null;
  },

  // cm:why the document is the slug's and the name's one source; `projects.slug` and `projects.name` are its projection, written in the document's transaction so a lookup by slug, a listing by name and the document never disagree
  async casProject({ projectId, baseRevision, document, userId }: CasInput): Promise<CasResult> {
    const { slug, name } = (document as ProjectDocument).project;
    try {
      return await db.transaction(async (tx) => {
        await lockConfig(tx, 'project', projectId);
        const [current] = await tx
          .select()
          .from(projectConfigDocuments)
          .where(eq(projectConfigDocuments.projectId, projectId))
          .limit(1);
        const storedRevision = current?.revision ?? null;
        if (storedRevision !== baseRevision) return { ok: false as const, storedRevision };
        if (current && sameJson(current.document, document)) {
          return { ok: true as const, stored: current, created: false };
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
        if (!row) throw new Error('project-config: document upsert returned no row');
        if (!(await projectConfigPorts().projectDocumentNames(tx, projectId, { slug, name }))) {
          throw new Error(
            `project-config: project ${projectId} has a document and no projects row`,
          );
        }
        return { ok: true as const, stored: row, created: true };
      });
    } catch (err) {
      if (isUniqueViolation(err) && uniqueViolationConstraint(err) === 'projects_slug_unique') {
        return {
          ok: false,
          refusal: {
            code: 'SLUG_TAKEN',
            path: '/project/slug',
            detail: `slug "${slug}" is already another project's; a slug is unique across the deployment.`,
          },
        };
      }
      throw err;
    }
  },

  async readPolicy(projectId: string): Promise<StoredDocument | null> {
    const [row] = await db
      .select()
      .from(projectPolicies)
      .where(eq(projectPolicies.projectId, projectId))
      .limit(1);
    return row ?? null;
  },

  async casPolicy({ projectId, baseRevision, document, userId }: CasInput): Promise<CasResult> {
    return db.transaction(async (tx) => {
      await lockConfig(tx, 'policy', projectId);
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

  async listTestingProfiles(projectId: string): Promise<StoredProfile[]> {
    return db
      .select()
      .from(projectTestingProfiles)
      .where(eq(projectTestingProfiles.projectId, projectId))
      .orderBy(projectTestingProfiles.profileId);
  },

  async readTestingProfile(projectId: string, profileId: string): Promise<StoredDocument | null> {
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

  async casTestingProfile({
    projectId,
    profileId,
    baseRevision,
    document,
    userId,
  }: CasInput & { profileId: string }): Promise<CasResult> {
    return db.transaction(async (tx) => {
      await lockConfig(tx, 'testing-profile', projectId, profileId);
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

  async deleteTestingProfile(projectId: string, profileId: string): Promise<boolean> {
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

  async listActiveBindings(projectId: string): Promise<BindingRow[]> {
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

  async slugTakenBy(projectId: string, slug: string): Promise<string | null> {
    const [holder] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.slug, slug), ne(projects.id, projectId)))
      .limit(1);
    return holder?.id ?? null;
  },

  async listSecretNames(projectId: string): Promise<SecretName[]> {
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

  async secretValues(projectId: string, refs: readonly string[]): Promise<Map<string, Buffer>> {
    const wanted = refs.map(parseSecretRef).filter((r) => r !== null);
    if (wanted.length === 0) return new Map();
    const rows = await db
      .select({
        scope: projectSecrets.scope,
        name: projectSecrets.name,
        valueEnc: projectSecrets.valueEnc,
      })
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
    return new Map(rows.map((r) => [secretRefOf(r.scope, r.name), r.valueEnc]));
  },

  async putSecret({
    projectId,
    scope,
    name,
    valueEnc,
  }: {
    projectId: string;
    scope: string;
    name: string;
    valueEnc: Buffer;
  }): Promise<SecretName> {
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

  async deviceCheckout(projectId: string, deviceId: string): Promise<DeviceCheckout | null> {
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

/** A new project's first policy revision. */
/** A new project's policy, revision 1: the default, so no default is invented later. */
export async function seedProjectPolicy(tx: Tx, projectId: string, userId: string): Promise<void> {
  await tx
    .insert(projectPolicies)
    .values({ projectId, revision: 1, document: DEFAULT_POLICY, updatedBy: userId });
}
