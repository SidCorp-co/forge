import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { projects, users } from '../db/schema.js';
import {
  channelCounters,
  contractVersions,
  ecosystemConsumptions,
  ecosystemMembershipEvents,
  ecosystemMemberships,
  ecosystemRevisions,
  ecosystems,
  projectInterfaceRevisions,
  projectInterfaces,
} from '../db/schema-ecosystem.js';
import type { MembershipRow, MembershipVerb } from './membership-rules.js';
import type { RevisionBy } from './provider-writer-rules.js';
import type { MembershipState } from './schema.js';

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
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ecosystem:${key}`}, 0))`);
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

const membershipColumns = {
  id: ecosystemMemberships.id,
  ecosystemId: ecosystemMemberships.ecosystemId,
  projectId: ecosystemMemberships.projectId,
  state: ecosystemMemberships.state,
  invitedBy: ecosystemMemberships.invitedBy,
  invitedAt: ecosystemMemberships.invitedAt,
  decidedBy: ecosystemMemberships.decidedBy,
  decidedAt: ecosystemMemberships.decidedAt,
  endedAt: ecosystemMemberships.endedAt,
  endedReason: ecosystemMemberships.endedReason,
};

const asMembership = (row: { state: string } & Omit<MembershipRow, 'state'>): MembershipRow => ({
  ...row,
  state: row.state as MembershipState,
});

export async function readMembership(tx: Tx, id: string): Promise<MembershipRow | null> {
  const [row] = await tx
    .select(membershipColumns)
    .from(ecosystemMemberships)
    .where(eq(ecosystemMemberships.id, id))
    .limit(1);
  return row ? asMembership(row) : null;
}

export async function membershipsWhere(filter: {
  ecosystemIds?: readonly string[];
  projectIds?: readonly string[];
}): Promise<MembershipRow[]> {
  const conditions = [
    ...(filter.ecosystemIds
      ? [inArray(ecosystemMemberships.ecosystemId, [...filter.ecosystemIds])]
      : []),
    ...(filter.projectIds ? [inArray(ecosystemMemberships.projectId, [...filter.projectIds])] : []),
  ];
  if (filter.ecosystemIds?.length === 0 || filter.projectIds?.length === 0) return [];
  if (conditions.length === 0) throw new Error('ecosystem: membershipsWhere needs a filter');
  const rows = await db
    .select(membershipColumns)
    .from(ecosystemMemberships)
    .where(and(...conditions))
    .orderBy(ecosystemMemberships.invitedAt);
  return rows.map(asMembership);
}

export async function openMembership(
  tx: Tx,
  ecosystemId: string,
  projectId: string,
): Promise<MembershipRow | null> {
  const [row] = await tx
    .select(membershipColumns)
    .from(ecosystemMemberships)
    .where(
      and(
        eq(ecosystemMemberships.ecosystemId, ecosystemId),
        eq(ecosystemMemberships.projectId, projectId),
        inArray(ecosystemMemberships.state, ['invited', 'active']),
      ),
    )
    .limit(1);
  return row ? asMembership(row) : null;
}

export async function insertInvitation(
  tx: Tx,
  input: { ecosystemId: string; projectId: string; userId: string },
): Promise<MembershipRow> {
  const [row] = await tx
    .insert(ecosystemMemberships)
    .values({
      ecosystemId: input.ecosystemId,
      projectId: input.projectId,
      state: 'invited',
      invitedBy: input.userId,
    })
    .returning(membershipColumns);
  if (!row) throw new Error('ecosystem: the invitation insert returned no row');
  await tx.insert(ecosystemMembershipEvents).values({
    membershipId: row.id,
    verb: 'invite',
    fromState: null,
    toState: 'invited',
    actorId: input.userId,
  });
  return asMembership(row);
}

export async function applyTransition(
  tx: Tx,
  input: {
    row: MembershipRow;
    verb: MembershipVerb;
    to: MembershipState;
    userId: string;
    reason: string | null;
  },
): Promise<MembershipRow | null> {
  const { row, verb, to, userId, reason } = input;
  const now = new Date();
  const deciding = row.state === 'invited';
  const [updated] = await tx
    .update(ecosystemMemberships)
    .set({
      state: to,
      ...(deciding ? { decidedBy: userId, decidedAt: now } : { endedAt: now, endedReason: reason }),
    })
    .where(and(eq(ecosystemMemberships.id, row.id), eq(ecosystemMemberships.state, row.state)))
    .returning(membershipColumns);
  if (!updated) return null;
  await tx.insert(ecosystemMembershipEvents).values({
    membershipId: row.id,
    verb,
    fromState: row.state,
    toState: to,
    actorId: userId,
    reason,
    at: now,
  });
  return asMembership(updated);
}

export async function readInterface(tx: Tx, projectId: string): Promise<StoredDocument | null> {
  const [row] = await tx
    .select()
    .from(projectInterfaces)
    .where(eq(projectInterfaces.projectId, projectId))
    .limit(1);
  return row ?? null;
}

export async function readInterfaces(
  tx: Tx,
  projectIds: readonly string[],
): Promise<Map<string, StoredDocument>> {
  if (projectIds.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(projectInterfaces)
    .where(inArray(projectInterfaces.projectId, [...projectIds]));
  return new Map(rows.map((r) => [r.projectId, r]));
}

export interface EdgeRow {
  consumerProjectId: string;
  providerProjectId: string;
  contractSlug: string;
  ecosystemId: string;
  builtAgainst: string;
}

export async function putInterface(
  tx: Tx,
  input: { projectId: string; revision: number; userId: string },
  document: unknown,
  edges: readonly EdgeRow[],
): Promise<StoredDocument> {
  const { projectId, revision, userId } = input;
  const now = new Date();
  const values = { projectId, revision, document, updatedBy: userId, updatedAt: now };
  const [row] = await tx
    .insert(projectInterfaces)
    .values(values)
    .onConflictDoUpdate({ target: projectInterfaces.projectId, set: values })
    .returning();
  await tx
    .insert(projectInterfaceRevisions)
    .values({ projectId, revision, document, writtenBy: userId, writtenAt: now });
  await tx
    .delete(ecosystemConsumptions)
    .where(eq(ecosystemConsumptions.consumerProjectId, projectId));
  if (edges.length > 0) await tx.insert(ecosystemConsumptions).values([...edges]);
  if (!row) throw new Error('ecosystem: the interface upsert returned no row');
  return row;
}

/** Each revision of a project's interface, newest first, with the agency of the account that wrote it. */
export async function interfaceRevisionsBy(tx: Tx, projectId: string): Promise<RevisionBy[]> {
  const rows = await tx
    .select({
      revision: projectInterfaceRevisions.revision,
      document: projectInterfaceRevisions.document,
      writtenBy: projectInterfaceRevisions.writtenBy,
      writtenAt: projectInterfaceRevisions.writtenAt,
      kind: users.kind,
    })
    .from(projectInterfaceRevisions)
    .leftJoin(users, eq(users.id, projectInterfaceRevisions.writtenBy))
    .where(eq(projectInterfaceRevisions.projectId, projectId))
    .orderBy(desc(projectInterfaceRevisions.revision));
  return rows.map(({ kind, ...r }) => ({ ...r, agency: kind === 'agent' ? 'agent' : 'human' }));
}

export async function listInterfaceRevisions(projectId: string): Promise<StoredRevision[]> {
  return db
    .select({
      revision: projectInterfaceRevisions.revision,
      document: projectInterfaceRevisions.document,
      writtenBy: projectInterfaceRevisions.writtenBy,
      writtenAt: projectInterfaceRevisions.writtenAt,
    })
    .from(projectInterfaceRevisions)
    .where(eq(projectInterfaceRevisions.projectId, projectId))
    .orderBy(desc(projectInterfaceRevisions.revision));
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

export async function activeEcosystemIdsOf(
  tx: Tx,
  projectIds: readonly string[],
): Promise<{ projectId: string; ecosystemId: string }[]> {
  if (projectIds.length === 0) return [];
  return tx
    .select({
      projectId: ecosystemMemberships.projectId,
      ecosystemId: ecosystemMemberships.ecosystemId,
    })
    .from(ecosystemMemberships)
    .where(
      and(
        inArray(ecosystemMemberships.projectId, [...projectIds]),
        eq(ecosystemMemberships.state, 'active'),
      ),
    );
}

export async function isActiveMember(
  tx: Tx,
  projectId: string,
  ecosystemId: string,
): Promise<boolean> {
  return (await activeEcosystemIdsOf(tx, [projectId])).some((m) => m.ecosystemId === ecosystemId);
}

export async function activeMembersOf(tx: Tx, ecosystemId: string): Promise<string[]> {
  const rows = await tx
    .select({ projectId: ecosystemMemberships.projectId })
    .from(ecosystemMemberships)
    .where(
      and(
        eq(ecosystemMemberships.ecosystemId, ecosystemId),
        eq(ecosystemMemberships.state, 'active'),
      ),
    );
  return rows.map((r) => r.projectId);
}

export async function recordedVersions(
  tx: Tx,
  providerIds: readonly string[],
): Promise<{ providerProjectId: string; contractSlug: string; version: string }[]> {
  if (providerIds.length === 0) return [];
  return tx
    .select({
      providerProjectId: contractVersions.providerProjectId,
      contractSlug: contractVersions.contractSlug,
      version: contractVersions.version,
    })
    .from(contractVersions)
    .where(inArray(contractVersions.providerProjectId, [...providerIds]))
    .orderBy(contractVersions.recordedAt);
}

export async function edgesIn(tx: Tx, ecosystemIds: readonly string[]): Promise<EdgeRow[]> {
  if (ecosystemIds.length === 0) return [];
  return tx
    .select()
    .from(ecosystemConsumptions)
    .where(inArray(ecosystemConsumptions.ecosystemId, [...ecosystemIds]));
}

export async function consumersOf(
  tx: Tx,
  providerId: string,
): Promise<
  { consumerId: string; consumerSlug: string; contractSlug: string; ecosystemId: string }[]
> {
  return tx
    .select({
      consumerId: ecosystemConsumptions.consumerProjectId,
      consumerSlug: projects.slug,
      contractSlug: ecosystemConsumptions.contractSlug,
      ecosystemId: ecosystemConsumptions.ecosystemId,
    })
    .from(ecosystemConsumptions)
    .innerJoin(projects, eq(projects.id, ecosystemConsumptions.consumerProjectId))
    .innerJoin(
      ecosystemMemberships,
      and(
        eq(ecosystemMemberships.projectId, ecosystemConsumptions.consumerProjectId),
        eq(ecosystemMemberships.ecosystemId, ecosystemConsumptions.ecosystemId),
        eq(ecosystemMemberships.state, 'active'),
      ),
    )
    .where(eq(ecosystemConsumptions.providerProjectId, providerId));
}
