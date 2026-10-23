/**
 * A lesson's text as project knowledge (REQ-50 BC-3, docs/proposals/lessons.md section 2). The
 * entry `lesson-<n>` of kind `lesson` is written only here, in the lessons module's own transaction:
 * `always` while the lesson is approved and `none` while it is held or retired, so the injection
 * a prompt reads can never run ahead of the lesson's decision. The month's figures (BC-8) are the
 * entry `lessons-month-<YYYY-MM>` of the same kind, `on_demand` for this month and the last, so an
 * agent fetches them like any project guide. The general knowledge doors refuse a write to either by
 * name (`lessonOwnedRefusal`). An entry is written with no vector; the embedding backfill fills it, as
 * it does any degraded write.
 */

import type { KnowledgeRefusalCode } from '@forge/contracts/knowledge';
import { and, asc, eq, inArray, isNull, like, ne, notInArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { knowledgeEntries } from '../db/schema.js';
import { type RefusalError, refuser } from '../lib/refusal.js';

const refuse = refuser<KnowledgeRefusalCode>('KNOWLEDGE_REFUSED');

export const lessonEntrySlug = (number: number) => `lesson-${number}`;

const MONTH_PREFIX = 'lessons-month-';
export const lessonsMonthSlug = (month: string) => `${MONTH_PREFIX}${month}`;

/** What a lesson entry's metadata holds: enough for a prompt to scope it without the lessons table. */
export interface LessonEntryMeta {
  lessonId: string;
  number: number;
  scope: {
    kind: 'project' | 'area' | 'item_kind';
    areaId: string | null;
    areaName: string | null;
    itemKind: string | null;
  };
}

export interface LessonEntry {
  slug: string;
  sentence: string;
  meta: LessonEntryMeta;
}

/** Write (or rewrite) a lesson's entry in the deciding transaction. */
export async function putLessonEntry(
  tx: Tx,
  input: {
    projectId: string;
    sentence: string;
    injection: 'always' | 'none';
    meta: LessonEntryMeta;
  },
): Promise<void> {
  const slug = lessonEntrySlug(input.meta.number);
  const row = {
    projectId: input.projectId,
    slug,
    title: `L-${input.meta.number}`,
    body: input.sentence,
    kind: 'lesson' as const,
    injection: input.injection,
    confidence: 'verified' as const,
    authoredBy: 'human' as const,
    orderIndex: input.meta.number,
    embedding: null,
    metadata: input.meta as unknown as Record<string, unknown>,
  };
  await tx
    .insert(knowledgeEntries)
    .values(row)
    .onConflictDoUpdate({
      target: [knowledgeEntries.projectId, knowledgeEntries.slug],
      set: {
        title: row.title,
        body: row.body,
        kind: row.kind,
        injection: row.injection,
        // a rewritten sentence is embedded again by the backfill; an unchanged one keeps its vector
        embedding: sql`CASE WHEN ${knowledgeEntries.body} = ${row.body} THEN ${knowledgeEntries.embedding} ELSE NULL END`,
        metadata: row.metadata,
        archivedAt: null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Write one month's figures as the entry `lessons-month-<month>`, `on_demand`, and turn every older
 * month's entry to `none`, keeping `current` (this month and the last). A body that has not changed is
 * not rewritten, so a pass that finds the same figures leaves the entry and its vector as they were.
 */
export async function putLessonsMonthEntry(input: {
  projectId: string;
  month: string;
  body: string;
  current: readonly string[];
}): Promise<void> {
  const slug = lessonsMonthSlug(input.month);
  const written = await db
    .insert(knowledgeEntries)
    .values({
      projectId: input.projectId,
      slug,
      title: `Lessons in ${input.month}`,
      body: input.body,
      kind: 'lesson',
      injection: 'on_demand',
      confidence: 'verified',
      authoredBy: 'agent',
      embedding: null,
      metadata: { month: input.month },
    })
    .onConflictDoUpdate({
      target: [knowledgeEntries.projectId, knowledgeEntries.slug],
      set: {
        body: input.body,
        injection: 'on_demand',
        embedding: null,
        archivedAt: null,
        updatedAt: new Date(),
      },
      setWhere: sql`${knowledgeEntries.kind} = 'lesson' AND (${knowledgeEntries.body} IS DISTINCT FROM ${input.body} OR ${knowledgeEntries.injection} <> 'on_demand' OR ${knowledgeEntries.archivedAt} IS NOT NULL)`,
    })
    .returning({ id: knowledgeEntries.id });
  if (written.length === 0) await requireMonthEntry(input.projectId, slug);
  await db
    .update(knowledgeEntries)
    .set({ injection: 'none', updatedAt: new Date() })
    .where(
      and(
        eq(knowledgeEntries.projectId, input.projectId),
        eq(knowledgeEntries.kind, 'lesson'),
        like(knowledgeEntries.slug, `${MONTH_PREFIX}%`),
        notInArray(knowledgeEntries.slug, input.current.map(lessonsMonthSlug)),
        ne(knowledgeEntries.injection, 'none'),
      ),
    );
}

/**
 * An upsert that wrote nothing either found the same figures, or met an entry of another kind under the
 * month's slug, written through the knowledge door before the lessons module claimed it. The second is
 * refused by name, never skipped: the month would otherwise go unrecorded with nothing said.
 */
async function requireMonthEntry(projectId: string, slug: string): Promise<void> {
  const [row] = await db
    .select({ kind: knowledgeEntries.kind })
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.projectId, projectId), eq(knowledgeEntries.slug, slug)));
  if (row && row.kind !== 'lesson') {
    throw new Error(
      `lessons: the month's figures cannot be recorded as \`${slug}\` in project ${projectId}: a \`${row.kind}\` entry already holds that slug; rename or delete it through the knowledge door`,
    );
  }
}

/** Hold or retire a lesson's entry, in the transaction that holds or retires the lesson. */
export async function setLessonEntryInjection(
  tx: Tx,
  projectId: string,
  number: number,
  injection: 'always' | 'none',
): Promise<void> {
  await tx
    .update(knowledgeEntries)
    .set({ injection, updatedAt: new Date() })
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        eq(knowledgeEntries.slug, lessonEntrySlug(number)),
        eq(knowledgeEntries.kind, 'lesson'),
      ),
    );
}

/** The approved lessons a prompt may carry: kind `lesson`, injected `always`, not archived. */
export async function selectLessonEntries(projectId: string): Promise<LessonEntry[]> {
  const rows = await db
    .select({
      slug: knowledgeEntries.slug,
      body: knowledgeEntries.body,
      metadata: knowledgeEntries.metadata,
    })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        eq(knowledgeEntries.kind, 'lesson'),
        eq(knowledgeEntries.injection, 'always'),
        isNull(knowledgeEntries.archivedAt),
      ),
    )
    .orderBy(asc(knowledgeEntries.orderIndex));
  return rows.map((r) => ({
    slug: r.slug,
    sentence: r.body,
    meta: r.metadata as unknown as LessonEntryMeta,
  }));
}

/**
 * The general knowledge doors' refusal for an entry the lessons module owns: a write naming kind
 * `lesson`, or any write or delete of a slug a lesson or a month's figures hold. A lesson changes only
 * by its own decisions, and a month's figures only by the steward's lessons pass.
 */
export async function lessonOwnedRefusal(
  projectId: string,
  writes: ReadonlyArray<{ slug: string; kind?: string | undefined }>,
): Promise<RefusalError | null> {
  const named = writes.find((w) => w.kind === 'lesson');
  if (named) {
    return refuse(
      'KNOWLEDGE_LESSON_OWNED',
      `\`${named.slug}\` names kind \`lesson\`: a lesson's entry is written only when the steward approves or edits the lesson, and a month's figures only by the steward's lessons pass, never through the knowledge door.`,
      '/kind',
    );
  }
  if (writes.length === 0) return null;
  const owned = await db
    .select({ slug: knowledgeEntries.slug })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        eq(knowledgeEntries.kind, 'lesson'),
        inArray(
          knowledgeEntries.slug,
          writes.map((w) => w.slug),
        ),
      ),
    )
    .limit(1);
  const slug = owned[0]?.slug;
  if (!slug) return null;
  if (slug.startsWith(MONTH_PREFIX)) {
    return refuse(
      'KNOWLEDGE_LESSON_OWNED',
      `\`${slug}\` is a month's lesson figures: the steward's lessons pass records them from the corrections, lessons and confusions themselves, never through the knowledge door.`,
      '/slug',
    );
  }
  return refuse(
    'KNOWLEDGE_LESSON_OWNED',
    `\`${slug}\` is a lesson's entry: it changes only through the lesson's own decisions, which the steward takes (approve, edit, hold, retire), never through the knowledge door.`,
    '/slug',
  );
}
