import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, knowledgeEntries } from '../db/schema.js';
import type { MasterVerb } from '../db/schema-master-charter.js';
import type { knowledgeInjectionEnum, knowledgeKindEnum } from './entry-input.js';
import type { ReadWhenCondition } from './read-when.js';

const MAX_RESPONSE_CHARS = 38_000;

export interface ListKnowledgeInput {
  projectId: string;
  kind?: (typeof knowledgeKindEnum)[number] | undefined;
  injection?: (typeof knowledgeInjectionEnum)[number] | undefined;
  /** Match an entry whose `readWhen.verbs` names this verb — combined with `status` by OR:
   *  what a master wants is everything worth reading at this moment, not only an entry that
   *  happens to declare both axes (ISS-1313 criterion 34). */
  verb?: MasterVerb | undefined;
  status?: IssueStatus | undefined;
}

export interface KnowledgeListRow {
  id: string;
  slug: string;
  kind: string;
  title: string;
  injection: string;
  confidence: string;
  authoredBy: string;
  orderIndex: number;
  updatedAt: Date;
  readWhen: ReadWhenCondition | null;
}

export interface ListKnowledgeResult {
  rows: KnowledgeListRow[];
  truncated: boolean;
  returned: number;
  total: number;
}

/**
 * The row cap on the LIST query. `MAX_RESPONSE_CHARS` is the real bound; this
 * only stops an unbounded fetch on the way to it, so it must sit ABOVE the
 * largest number of rows that can fit under the character cap — otherwise the
 * database would cut a row the cap would have kept, which is the silent
 * shortening this bound exists to prevent. `service.test.ts` holds it: the
 * shortest row this projection can serialise, taken MAX_LIST_ROWS times, is
 * longer than MAX_RESPONSE_CHARS.
 */
export const MAX_LIST_ROWS = 1000;

/** `{"rows":[]}` — the envelope the cap is measured against. */
const RESPONSE_ENVELOPE_CHARS = 11;

/**
 * Keep the longest prefix of `rows` whose serialisation fits under
 * `MAX_RESPONSE_CHARS`, at least one row — a single row wider than the cap is
 * returned rather than dropped, as it was before. `truncated` is now
 * `returned < total` on every path, so that one row reads as complete instead
 * of truncated; the projection's own field caps (slug 512, title 500) put the
 * widest possible row near 1.2k characters, so nothing reaches it.
 */
function trimToResponseCap(rows: KnowledgeListRow[]): KnowledgeListRow[] {
  let used = RESPONSE_ENVELOPE_CHARS;
  for (let i = 0; i < rows.length; i += 1) {
    // biome-ignore lint/style/noNonNullAssertion: index is below rows.length
    used += JSON.stringify(rows[i]!).length + (i > 0 ? 1 : 0);
    if (used > MAX_RESPONSE_CHARS) return rows.slice(0, Math.max(1, i));
  }
  return rows;
}

export async function listKnowledgeEntries(
  input: ListKnowledgeInput,
): Promise<ListKnowledgeResult> {
  const verbMatch = input.verb
    ? sql`${knowledgeEntries.readWhen} -> 'verbs' @> ${JSON.stringify([input.verb])}::jsonb`
    : undefined;
  const statusMatch = input.status
    ? sql`${knowledgeEntries.readWhen} -> 'statuses' @> ${JSON.stringify([input.status])}::jsonb`
    : undefined;
  const conditionMatch =
    verbMatch && statusMatch ? or(verbMatch, statusMatch) : (verbMatch ?? statusMatch);

  const where = [
    eq(knowledgeEntries.projectId, input.projectId),
    isNull(knowledgeEntries.archivedAt),
    ...(input.kind ? [eq(knowledgeEntries.kind, input.kind)] : []),
    ...(input.injection ? [eq(knowledgeEntries.injection, input.injection)] : []),
    ...(conditionMatch ? [conditionMatch] : []),
  ];

  const fetched = await db
    .select({
      id: knowledgeEntries.id,
      slug: knowledgeEntries.slug,
      kind: knowledgeEntries.kind,
      title: knowledgeEntries.title,
      injection: knowledgeEntries.injection,
      confidence: knowledgeEntries.confidence,
      authoredBy: knowledgeEntries.authoredBy,
      orderIndex: knowledgeEntries.orderIndex,
      updatedAt: knowledgeEntries.updatedAt,
      readWhen: knowledgeEntries.readWhen,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(knowledgeEntries)
    .where(and(...where))
    .orderBy(asc(knowledgeEntries.orderIndex), asc(knowledgeEntries.slug))
    .limit(MAX_LIST_ROWS);

  const total = fetched[0]?.total ?? 0;
  const rows: KnowledgeListRow[] = fetched.map(({ total: _total, ...row }) => ({
    ...row,
    readWhen: (row.readWhen as ReadWhenCondition | null) ?? null,
  }));

  const kept = trimToResponseCap(rows);
  return { rows: kept, truncated: kept.length < total, returned: kept.length, total };
}

export interface GetKnowledgeResult {
  id: string;
  slug: string;
  kind: string;
  title: string;
  body: string;
  injection: string;
  confidence: string;
  authoredBy: string;
  orderIndex: number;
  metadata: unknown;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  readWhen: ReadWhenCondition | null;
}

export async function getKnowledgeEntry(
  projectId: string,
  slug: string,
): Promise<GetKnowledgeResult | null> {
  const [row] = await db
    .select({
      id: knowledgeEntries.id,
      slug: knowledgeEntries.slug,
      kind: knowledgeEntries.kind,
      title: knowledgeEntries.title,
      body: knowledgeEntries.body,
      injection: knowledgeEntries.injection,
      confidence: knowledgeEntries.confidence,
      authoredBy: knowledgeEntries.authoredBy,
      orderIndex: knowledgeEntries.orderIndex,
      metadata: knowledgeEntries.metadata,
      archivedAt: knowledgeEntries.archivedAt,
      createdAt: knowledgeEntries.createdAt,
      updatedAt: knowledgeEntries.updatedAt,
      readWhen: knowledgeEntries.readWhen,
    })
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.projectId, projectId), eq(knowledgeEntries.slug, slug)))
    .limit(1);
  if (!row) return null;
  return { ...row, readWhen: (row.readWhen as ReadWhenCondition | null) ?? null };
}

export async function deleteKnowledgeEntry(projectId: string, slug: string): Promise<number> {
  const result = await db
    .delete(knowledgeEntries)
    .where(and(eq(knowledgeEntries.projectId, projectId), eq(knowledgeEntries.slug, slug)))
    .returning({ id: knowledgeEntries.id });
  return result.length;
}

export interface AlwaysInjectFact {
  key: string;
  text: string;
}

export async function selectAlwaysInjectFromKnowledge(
  projectId: string,
): Promise<AlwaysInjectFact[]> {
  const rows = await db
    .select({
      slug: knowledgeEntries.slug,
      body: knowledgeEntries.body,
      orderIndex: knowledgeEntries.orderIndex,
    })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        eq(knowledgeEntries.injection, 'always'),
        isNull(knowledgeEntries.archivedAt),
      ),
    )
    .orderBy(asc(knowledgeEntries.orderIndex), asc(knowledgeEntries.slug));
  return rows.map((r) => ({ key: r.slug, text: r.body }));
}

/** Every non-archived slug this project holds whose body is more than whitespace, whatever its
 *  injection setting — what `missingProjectKnowledge` measures the contract against. */
export async function selectAllSlugsFromKnowledge(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: knowledgeEntries.slug })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        isNull(knowledgeEntries.archivedAt),
        sql`${knowledgeEntries.body} ~ '[^[:space:]]'`,
      ),
    )
    .orderBy(asc(knowledgeEntries.slug));
  return rows.map((r) => r.slug);
}

export async function selectOnDemandSlugsFromKnowledge(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: knowledgeEntries.slug, orderIndex: knowledgeEntries.orderIndex })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        eq(knowledgeEntries.injection, 'on_demand'),
        isNull(knowledgeEntries.archivedAt),
      ),
    )
    .orderBy(asc(knowledgeEntries.orderIndex), asc(knowledgeEntries.slug));
  return rows.map((r) => r.slug);
}

/** A knowledge node's related issues and, when given, its metadata, written by a module refresh. */
export async function updateKnowledgeLinks(
  nodeId: string,
  set: { relatedIssueIds?: string[]; metadata?: Record<string, unknown>; at: Date },
): Promise<void> {
  await db
    .update(knowledgeEntries)
    .set({
      ...(set.relatedIssueIds ? { relatedIssueIds: set.relatedIssueIds } : {}),
      ...(set.metadata ? { metadata: set.metadata } : {}),
      updatedAt: set.at,
    })
    .where(eq(knowledgeEntries.id, nodeId));
}

/** A knowledge entry that had no embedding is given one; a concurrent writer's stays. */
export async function fillKnowledgeEmbedding(entryId: string, vector: number[]): Promise<void> {
  await db
    .update(knowledgeEntries)
    .set({ embedding: vector })
    .where(and(eq(knowledgeEntries.id, entryId), isNull(knowledgeEntries.embedding)));
}
