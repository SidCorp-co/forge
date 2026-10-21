/**
 * A lesson's text as project knowledge (REQ-50 BC-3, docs/proposals/lessons.md section 2). The
 * entry `lesson-<n>` of kind `lesson` is written only here, in the lessons module's own transaction:
 * `always` while the lesson is approved and `none` while it is held or retired, so the injection
 * a prompt reads can never run ahead of the lesson's decision. The general knowledge doors refuse a
 * write to it by name (`lessonOwnedRefusal`). The entry is written with no vector; the embedding
 * backfill fills it, as it does any degraded write.
 */

import type { KnowledgeRefusalCode } from '@forge/contracts/knowledge';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { knowledgeEntries } from '../db/schema.js';
import { type RefusalError, refuser } from '../lib/refusal.js';

const refuse = refuser<KnowledgeRefusalCode>('KNOWLEDGE_REFUSED');

export const lessonEntrySlug = (number: number) => `lesson-${number}`;

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
 * The general knowledge doors' refusal for a lesson's entry: a write naming kind `lesson`, or any
 * write or delete of a slug a lesson holds. A lesson changes only by its own decisions.
 */
export async function lessonOwnedRefusal(
  projectId: string,
  writes: ReadonlyArray<{ slug: string; kind?: string | undefined }>,
): Promise<RefusalError | null> {
  const named = writes.find((w) => w.kind === 'lesson');
  if (named) {
    return refuse(
      'KNOWLEDGE_LESSON_OWNED',
      `\`${named.slug}\` names kind \`lesson\`: a lesson's entry is written only when a person approves or edits the lesson (POST /api/projects/:id/lessons/:n/approve), never through the knowledge door.`,
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
  return refuse(
    'KNOWLEDGE_LESSON_OWNED',
    `\`${slug}\` is a lesson's entry: it changes only through the lesson's own decisions on the Lessons page (approve, edit, hold, retire), never through the knowledge door.`,
    '/slug',
  );
}
