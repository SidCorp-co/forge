import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { projects } from '../db/schema.js';
import {
  channelCounters,
  contractVersions,
  ecosystemMemberships,
  ecosystemRevisions,
  ecosystems,
  projectInterfaces,
} from '../db/schema-ecosystem.js';
import { lockXact } from '../lib/advisory-lock.js';

export interface StoredDocument {
  revision: number;
  document: unknown;
  updatedBy: string;
  updatedAt: Date;
}

export interface StoredEcosystem extends StoredDocument {
  id: string;
  stewardOrgId: string;
}

export interface StoredRevision {
  revision: number;
  document: unknown;
  writtenBy: string;
  writtenAt: Date;
}

export async function lockKeys(tx: Tx, keys: readonly string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await lockXact(tx, 'ecosystem', key);
  }
}

export async function readEcosystem(tx: Tx, id: string): Promise<StoredEcosystem | null> {
  const [row] = await tx
    .select({
      id: ecosystems.id,
      stewardOrgId: ecosystems.stewardOrgId,
      revision: ecosystems.revision,
      document: ecosystems.document,
      updatedBy: ecosystems.updatedBy,
      updatedAt: ecosystems.updatedAt,
    })
    .from(ecosystems)
    .where(eq(ecosystems.id, id))
    .limit(1);
  return row ?? null;
}

export async function readEcosystems(tx: Tx, ids: readonly string[]): Promise<StoredEcosystem[]> {
  if (ids.length === 0) return [];
  return tx
    .select({
      id: ecosystems.id,
      stewardOrgId: ecosystems.stewardOrgId,
      revision: ecosystems.revision,
      document: ecosystems.document,
      updatedBy: ecosystems.updatedBy,
      updatedAt: ecosystems.updatedAt,
    })
    .from(ecosystems)
    .where(inArray(ecosystems.id, [...ids]));
}

export async function ecosystemHolding(
  tx: Tx,
  column: 'slug' | 'channelCode',
  value: string,
  exceptId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: ecosystems.id })
    .from(ecosystems)
    .where(and(eq(ecosystems[column], value), sql`${ecosystems.id} <> ${exceptId}`))
    .limit(1);
  return row?.id ?? null;
}

export async function numbersReserved(tx: Tx, ecosystemId: string): Promise<boolean> {
  const [row] = await tx
    .select({ type: channelCounters.type })
    .from(channelCounters)
    .where(eq(channelCounters.ecosystemId, ecosystemId))
    .limit(1);
  return row !== undefined;
}

export async function activeMemberInterfaces(
  tx: Tx,
  ecosystemId: string,
): Promise<{ projectSlug: string; document: unknown }[]> {
  return tx
    .select({ projectSlug: projects.slug, document: projectInterfaces.document })
    .from(ecosystemMemberships)
    .innerJoin(projects, eq(projects.id, ecosystemMemberships.projectId))
    .innerJoin(projectInterfaces, eq(projectInterfaces.projectId, ecosystemMemberships.projectId))
    .where(
      and(
        eq(ecosystemMemberships.ecosystemId, ecosystemId),
        eq(ecosystemMemberships.state, 'active'),
      ),
    );
}

export async function putEcosystem(
  tx: Tx,
  input: { id: string; revision: number; slug: string; channelCode: string; stewardOrgId: string },
  document: unknown,
  userId: string,
): Promise<StoredEcosystem> {
  const now = new Date();
  const values = { ...input, document, updatedBy: userId, updatedAt: now };
  const [row] = await tx
    .insert(ecosystems)
    .values(values)
    .onConflictDoUpdate({ target: ecosystems.id, set: values })
    .returning();
  await tx.insert(ecosystemRevisions).values({
    ecosystemId: input.id,
    revision: input.revision,
    document,
    writtenBy: userId,
    writtenAt: now,
  });
  if (!row) throw new Error('ecosystem: the ecosystem upsert returned no row');
  return row;
}

export async function listEcosystemRevisions(id: string): Promise<StoredRevision[]> {
  return db
    .select({
      revision: ecosystemRevisions.revision,
      document: ecosystemRevisions.document,
      writtenBy: ecosystemRevisions.writtenBy,
      writtenAt: ecosystemRevisions.writtenAt,
    })
    .from(ecosystemRevisions)
    .where(eq(ecosystemRevisions.ecosystemId, id))
    .orderBy(desc(ecosystemRevisions.revision));
}

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
}

export async function projectsWhere(
  tx: Tx,
  by: { ids?: readonly string[]; slugs?: readonly string[] },
): Promise<ProjectRow[]> {
  const ids = by.ids ?? [];
  const slugs = by.slugs ?? [];
  if (ids.length === 0 && slugs.length === 0) return [];
  return tx
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .where(
      ids.length > 0 && slugs.length > 0
        ? sql`${inArray(projects.id, [...ids])} OR ${inArray(projects.slug, [...slugs])}`
        : ids.length > 0
          ? inArray(projects.id, [...ids])
          : inArray(projects.slug, [...slugs]),
    );
}

export async function recordedVersions(
  tx: Tx,
  providerIds: readonly string[],
): Promise<
  { providerProjectId: string; contractSlug: string; version: string; approval: string }[]
> {
  if (providerIds.length === 0) return [];
  return tx
    .select({
      providerProjectId: contractVersions.providerProjectId,
      contractSlug: contractVersions.contractSlug,
      version: contractVersions.version,
      approval: contractVersions.approval,
    })
    .from(contractVersions)
    .where(inArray(contractVersions.providerProjectId, [...providerIds]))
    .orderBy(contractVersions.recordedAt);
}
