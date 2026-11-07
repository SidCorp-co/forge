// REQ-89 BC-2 (ISS-1121): a knowledge write on a subject already held updates that entry rather than
// adding a second beside it. Under its own slug that is the upsert itself, and the text it replaced
// stays in `knowledge_entry_revisions`. Under a new slug whose text is near-identical to a live
// entry's, the write is refused `KNOWLEDGE_SUBJECT_HELD` naming that entry, unless it names it in
// `replaces`, which retires it as superseded by the new one. A lesson is the lessons module's and is
// never weighed here.

import type { KnowledgeRefusalCode } from '@forge/contracts/knowledge';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cosineDistance } from '../db/pgvector.js';
import { knowledgeEntries } from '../db/schema.js';
import { refuser } from '../lib/refusal.js';
import type { UpsertKnowledgeInput } from './entry-input.js';

const refuse = refuser<KnowledgeRefusalCode>('KNOWLEDGE_REFUSED');

/** The similarity at which two entries hold one subject; memory's near-duplicate threshold. */
export const SUBJECT_HELD_SCORE = 0.85;

/** The slugs among `slugs` the project already holds, archived or not. */
async function heldSlugs(projectId: string, slugs: string[]): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();
  const rows = await db
    .select({ slug: knowledgeEntries.slug })
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.projectId, projectId), inArray(knowledgeEntries.slug, slugs)));
  return new Set(rows.map((r) => r.slug));
}

/** The closest live entry of another slug, not a lesson, and its similarity. */
async function closestOther(projectId: string, slug: string, vector: number[]) {
  const [row] = await db
    .select({
      slug: knowledgeEntries.slug,
      distance: cosineDistance(knowledgeEntries.embedding, vector).as('distance'),
    })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        isNull(knowledgeEntries.archivedAt),
        ne(knowledgeEntries.kind, 'lesson'),
        ne(knowledgeEntries.slug, slug),
        sql`${knowledgeEntries.embedding} IS NOT NULL`,
      ),
    )
    .orderBy(sql`distance`)
    .limit(1);
  return row ? { slug: row.slug, score: 1 - Number(row.distance) } : null;
}

/**
 * The refusal of a write naming a new slug for a subject a live entry already holds, or null. Read
 * only where the write was embedded: a degraded write is weighed by nobody, and says so in its log.
 */
export async function subjectHeldRefusal(
  entries: UpsertKnowledgeInput[],
  vectors: Array<number[] | null>,
) {
  for (const projectId of new Set(entries.map((e) => e.projectId))) {
    const mine = entries.filter((e) => e.projectId === projectId);
    const held = await heldSlugs(
      projectId,
      mine.map((e) => e.slug),
    );
    for (const entry of mine) {
      if (held.has(entry.slug) || entry.kind === 'lesson') continue;
      const vector = vectors[entries.indexOf(entry)];
      if (!vector) continue;
      const other = await closestOther(projectId, entry.slug, vector);
      if (!other || other.score <= SUBJECT_HELD_SCORE || other.slug === entry.replaces) continue;
      return refuse(
        'KNOWLEDGE_SUBJECT_HELD',
        `\`${entry.slug}\` would be a second entry on the subject \`${other.slug}\` already holds (similarity ${other.score.toFixed(2)}): update that entry with PUT …/knowledge/${other.slug}, or keep this slug and send \`"replaces": "${other.slug}"\` to retire it as superseded. Nothing was written.`,
        '/slug',
      );
    }
  }
  return null;
}

/** Retire each entry a write named in `replaces`, as superseded by the slug that replaced it. */
export async function retireReplaced(
  entries: UpsertKnowledgeInput[],
): Promise<Map<string, string>> {
  const retired = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.replaces || entry.replaces === entry.slug) continue;
    const rows = await db
      .update(knowledgeEntries)
      .set({
        archivedAt: sql`now()`,
        metadata: sql`${knowledgeEntries.metadata} || jsonb_build_object('supersededBy', ${entry.slug}::text)`,
      })
      .where(
        and(
          eq(knowledgeEntries.projectId, entry.projectId),
          eq(knowledgeEntries.slug, entry.replaces),
          ne(knowledgeEntries.kind, 'lesson'),
          isNull(knowledgeEntries.archivedAt),
        ),
      )
      .returning({ slug: knowledgeEntries.slug });
    if (rows.length > 0) retired.set(entry.slug, entry.replaces);
  }
  return retired;
}
