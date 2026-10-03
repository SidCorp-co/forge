import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { ecosystemBuilderRuns, ecosystemLinks } from '../db/schema-ecosystem-links.js';
import type { BuilderRunWrite, LinkWrite } from './link-schema.js';

export interface StoredRecord {
  id: string;
  /** Null only on an in-project link; a builder run always names its ecosystem. */
  ecosystemId: string | null;
  projectId: string;
  revision: number;
  document: unknown;
  writtenByUser: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A builder run, which is always read against one ecosystem (`ecosystem_builder_runs.ecosystem_id` is NOT NULL). */
export interface StoredRun extends StoredRecord {
  ecosystemId: string;
}

export interface StoredLink extends StoredRecord {
  providerProjectId: string;
  contractSlug: string;
  modulePath: string;
  pinnedVersion: string;
  state: string;
}

const linkColumns = {
  id: ecosystemLinks.id,
  ecosystemId: ecosystemLinks.ecosystemId,
  projectId: ecosystemLinks.consumerProjectId,
  providerProjectId: ecosystemLinks.providerProjectId,
  contractSlug: ecosystemLinks.contractSlug,
  modulePath: ecosystemLinks.modulePath,
  pinnedVersion: ecosystemLinks.pinnedVersion,
  state: ecosystemLinks.state,
  revision: ecosystemLinks.revision,
  document: ecosystemLinks.document,
  writtenByUser: ecosystemLinks.writtenByUser,
  createdAt: ecosystemLinks.createdAt,
  updatedAt: ecosystemLinks.updatedAt,
};

const linkValues = (doc: LinkWrite) => ({
  ecosystemId: doc.ecosystem ?? null,
  consumerProjectId: doc.consumer.project,
  modulePath: doc.consumer.module,
  providerProjectId: doc.contract.provider,
  contractSlug: doc.contract.slug,
  pinnedVersion: doc.pinnedVersion,
  state: doc.state,
  document: doc,
});

export async function linkHolding(tx: Tx, doc: LinkWrite): Promise<string | null> {
  const [row] = await tx
    .select({ id: ecosystemLinks.id })
    .from(ecosystemLinks)
    .where(
      and(
        eq(ecosystemLinks.consumerProjectId, doc.consumer.project),
        eq(ecosystemLinks.modulePath, doc.consumer.module),
        eq(ecosystemLinks.providerProjectId, doc.contract.provider),
        eq(ecosystemLinks.contractSlug, doc.contract.slug),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

export async function readLink(tx: Tx, id: string): Promise<StoredLink | null> {
  const [row] = await tx.select(linkColumns).from(ecosystemLinks).where(eq(ecosystemLinks.id, id));
  return row ?? null;
}

export async function linksWhere(
  tx: Tx,
  by: { consumerId?: string; ecosystemIds?: readonly string[] },
): Promise<StoredLink[]> {
  const conditions = [
    ...(by.consumerId ? [eq(ecosystemLinks.consumerProjectId, by.consumerId)] : []),
    ...(by.ecosystemIds ? [inArray(ecosystemLinks.ecosystemId, [...by.ecosystemIds])] : []),
  ];
  if (by.ecosystemIds?.length === 0) return [];
  if (conditions.length === 0) throw new Error('ecosystem: linksWhere needs a filter');
  return tx
    .select(linkColumns)
    .from(ecosystemLinks)
    .where(and(...conditions))
    .orderBy(ecosystemLinks.createdAt, ecosystemLinks.id);
}

export async function insertLink(tx: Tx, doc: LinkWrite, userId: string): Promise<StoredLink> {
  const [row] = await tx
    .insert(ecosystemLinks)
    .values({ ...linkValues(doc), revision: 1, writtenByUser: userId })
    .returning(linkColumns);
  if (!row) throw new Error('ecosystem: the link insert returned no row');
  return row;
}

export async function replaceLink(
  tx: Tx,
  input: { id: string; revision: number; doc: LinkWrite; userId: string },
): Promise<StoredLink> {
  const [row] = await tx
    .update(ecosystemLinks)
    .set({
      ...linkValues(input.doc),
      revision: input.revision + 1,
      writtenByUser: input.userId,
      updatedAt: sql`now()`,
    })
    .where(and(eq(ecosystemLinks.id, input.id), eq(ecosystemLinks.revision, input.revision)))
    .returning(linkColumns);
  if (!row) throw new Error(`ecosystem: link ${input.id} moved under its own lock`);
  return row;
}

const runColumns = {
  id: ecosystemBuilderRuns.id,
  ecosystemId: ecosystemBuilderRuns.ecosystemId,
  projectId: ecosystemBuilderRuns.projectId,
  revision: ecosystemBuilderRuns.revision,
  document: ecosystemBuilderRuns.document,
  writtenByUser: ecosystemBuilderRuns.writtenByUser,
  createdAt: ecosystemBuilderRuns.createdAt,
  updatedAt: ecosystemBuilderRuns.updatedAt,
};

const runValues = (doc: BuilderRunWrite) => ({
  ecosystemId: doc.ecosystem,
  projectId: doc.project,
  trigger: doc.trigger.kind,
  triggerSha: doc.trigger.sha,
  document: doc,
});

export async function readBuilderRun(tx: Tx, id: string): Promise<StoredRun | null> {
  const [row] = await tx
    .select(runColumns)
    .from(ecosystemBuilderRuns)
    .where(eq(ecosystemBuilderRuns.id, id));
  return row ?? null;
}

export async function builderRunsOf(tx: Tx, projectId: string): Promise<StoredRun[]> {
  return tx
    .select(runColumns)
    .from(ecosystemBuilderRuns)
    .where(eq(ecosystemBuilderRuns.projectId, projectId))
    .orderBy(desc(ecosystemBuilderRuns.createdAt), ecosystemBuilderRuns.id);
}

export async function builderRunsIn(tx: Tx, ecosystemId: string): Promise<StoredRun[]> {
  return tx
    .select(runColumns)
    .from(ecosystemBuilderRuns)
    .where(eq(ecosystemBuilderRuns.ecosystemId, ecosystemId))
    .orderBy(desc(ecosystemBuilderRuns.createdAt), ecosystemBuilderRuns.id);
}

export async function insertBuilderRun(
  tx: Tx,
  doc: BuilderRunWrite,
  userId: string,
): Promise<StoredRun> {
  const [row] = await tx
    .insert(ecosystemBuilderRuns)
    .values({ ...runValues(doc), revision: 1, writtenByUser: userId })
    .returning(runColumns);
  if (!row) throw new Error('ecosystem: the builder run insert returned no row');
  return row;
}

export async function replaceBuilderRun(
  tx: Tx,
  input: { id: string; revision: number; doc: BuilderRunWrite; userId: string },
): Promise<StoredRun> {
  const [row] = await tx
    .update(ecosystemBuilderRuns)
    .set({
      ...runValues(input.doc),
      revision: input.revision + 1,
      writtenByUser: input.userId,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(ecosystemBuilderRuns.id, input.id), eq(ecosystemBuilderRuns.revision, input.revision)),
    )
    .returning(runColumns);
  if (!row) throw new Error(`ecosystem: builder run ${input.id} moved under its own lock`);
  return row;
}

// cm:edge contract -> packages/core/src/ecosystem/link-rules.ts:isOpenRun — the same reading of "open", in SQL: a step still pending or running
export async function openBuilderRunOf(
  tx: Tx,
  by: { projectId: string; ecosystemId: string; exceptId: string | null },
): Promise<string | null> {
  const [row] = await tx
    .select({ id: ecosystemBuilderRuns.id })
    .from(ecosystemBuilderRuns)
    .where(
      and(
        eq(ecosystemBuilderRuns.projectId, by.projectId),
        eq(ecosystemBuilderRuns.ecosystemId, by.ecosystemId),
        sql`(${ecosystemBuilderRuns.document}->'steps' @> '[{"status":"pending"}]'::jsonb OR ${ecosystemBuilderRuns.document}->'steps' @> '[{"status":"running"}]'::jsonb)`,
        ...(by.exceptId ? [sql`${ecosystemBuilderRuns.id} <> ${by.exceptId}`] : []),
      ),
    )
    .orderBy(ecosystemBuilderRuns.createdAt)
    .limit(1);
  return row?.id ?? null;
}
