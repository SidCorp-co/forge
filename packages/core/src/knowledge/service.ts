import type { KnowledgeProvenance } from '@forge/contracts/knowledge';
import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, knowledgeEntries } from '../db/schema.js';
import type { MasterVerb } from '../db/schema-master-charter.js';
import type { knowledgeInjectionEnum, knowledgeKindEnum } from './entry-input.js';
import { lessonOwnedRefusal, notALessonEntry } from './lesson-entries.js';
import { orgAlwaysInjectOf, orgEntryForProject, orgOnDemandSourcesOf } from './org-knowledge.js';
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

export interface KnowledgeListRow extends KnowledgeProvenance {
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
      source: knowledgeEntries.source,
      scope: knowledgeEntries.scope,
      recheckWhen: knowledgeEntries.recheckWhen,
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

export interface GetKnowledgeResult extends KnowledgeProvenance {
  /** `project` for the project's own entry; `org` where the project holds none under the slug and
   *  its org does (ISS-867), read through the same door so a project's agents need no org access. */
  origin: 'project' | 'org';
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
      source: knowledgeEntries.source,
      scope: knowledgeEntries.scope,
      recheckWhen: knowledgeEntries.recheckWhen,
    })
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.projectId, projectId), eq(knowledgeEntries.slug, slug)))
    .limit(1);
  if (!row) return null;
  return {
    origin: 'project',
    ...row,
    readWhen: (row.readWhen as ReadWhenCondition | null) ?? null,
  };
}

/**
 * What a project's agents read under `slug` through the project's own knowledge door: the project's
 * entry, else its org's (ISS-867), so an org's on-demand guide a prompt names is readable by every
 * agent of its projects without org access. Labelled by `origin`, never passed off as the project's.
 */
export async function readKnowledgeEntry(
  projectId: string,
  slug: string,
): Promise<GetKnowledgeResult | null> {
  const own = await getKnowledgeEntry(projectId, slug);
  if (own) return own;
  const org = await orgEntryForProject(projectId, slug);
  if (!org) return null;
  // an org entry carries no kind, confidence or author of its own: it is a ruling an org admin wrote
  return {
    origin: 'org',
    id: org.id,
    slug: org.slug,
    kind: 'rule',
    title: org.title,
    body: org.body,
    injection: org.injection,
    confidence: 'verified',
    authoredBy: 'human',
    orderIndex: org.orderIndex,
    metadata: { orgId: org.orgId },
    archivedAt: null,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
    readWhen: null,
    source: org.source,
    scope: org.scope,
    recheckWhen: org.recheckWhen,
  };
}

/** A rule of a project as a question names it (ISS-869), or why the slug names none. */
export type ProjectRuleRead =
  | { ok: true; slug: string; title: string }
  | { ok: false; why: string };

/**
 * Whether `slug` names a live rule of the project: an entry of kind `rule`, or one carried into every
 * prompt as a project rule (`injection: 'always'`), the project's own or its org's ruling read through
 * the project's door (`readKnowledgeEntry`). An archived entry or a lesson is none; why is said.
 */
export async function readProjectRule(projectId: string, slug: string): Promise<ProjectRuleRead> {
  const entry = await readKnowledgeEntry(projectId, slug);
  if (!entry) return { ok: false, why: `the project holds no knowledge entry \`${slug}\`` };
  if (entry.archivedAt) return { ok: false, why: `knowledge entry \`${slug}\` is archived` };
  if (entry.kind === 'lesson' || (entry.kind !== 'rule' && entry.injection !== 'always')) {
    return {
      ok: false,
      why: `knowledge entry \`${slug}\` is a ${entry.kind} read ${entry.injection}, not a rule: a rule is an entry of kind \`rule\`, or one carried into every prompt (\`injection: "always"\`)`,
    };
  }
  return { ok: true, slug: entry.slug, title: entry.title };
}

export async function deleteKnowledgeEntry(projectId: string, slug: string): Promise<number> {
  const owned = await lessonOwnedRefusal(projectId, [{ slug }]);
  if (owned) throw owned;
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

/**
 * The always-on facts of a project's prompt: its org's entries first, then its own (ISS-861). A
 * project entry under an org entry's slug, archived or not carried, takes that entry's place, so a
 * project can narrow or withdraw a ruling of its org by writing its own.
 */
export async function selectAlwaysInjectFromKnowledge(
  projectId: string,
): Promise<AlwaysInjectFact[]> {
  const [org, own, held] = await Promise.all([
    orgAlwaysInjectOf(projectId),
    projectAlwaysInject(projectId),
    db
      .select({ slug: knowledgeEntries.slug })
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.projectId, projectId)),
  ]);
  const overridden = new Set(held.map((r) => r.slug));
  return [
    ...org.filter((r) => !overridden.has(r.slug)).map((r) => ({ key: r.slug, text: r.body })),
    ...own,
  ];
}

async function projectAlwaysInject(projectId: string): Promise<AlwaysInjectFact[]> {
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
        // a lesson is named in its own scoped map (`lessons/block.ts`), never carried as a rule
        ne(knowledgeEntries.kind, 'lesson'),
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
        // the lessons map names the approved lessons, so the guide index does not name them twice
        notALessonEntry,
      ),
    )
    .orderBy(asc(knowledgeEntries.orderIndex), asc(knowledgeEntries.slug));
  return rows.map((r) => r.slug);
}

/**
 * What each on-demand entry a prompt's guide index names rests on, by slug: the project's own and its
 * org's it does not shadow, null where the entry was written before a source was asked for (ISS-1064).
 */
export async function selectOnDemandSourcesFromKnowledge(
  projectId: string,
): Promise<Record<string, string | null>> {
  const [own, org] = await Promise.all([
    db
      .select({ slug: knowledgeEntries.slug, source: knowledgeEntries.source })
      .from(knowledgeEntries)
      .where(
        and(
          eq(knowledgeEntries.projectId, projectId),
          eq(knowledgeEntries.injection, 'on_demand'),
          isNull(knowledgeEntries.archivedAt),
          notALessonEntry,
        ),
      ),
    orgOnDemandSourcesOf(projectId),
  ]);
  return { ...org, ...Object.fromEntries(own.map((r) => [r.slug, r.source])) };
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
