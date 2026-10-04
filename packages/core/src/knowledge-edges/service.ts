import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEdges } from '../db/schema.js';

/** A subject–predicate–object fact, written unless the project already holds it; true when written. */
export async function insertKnowledgeEdgeOnce(edge: {
  projectId: string;
  subject: string;
  predicate: string;
  object: string;
  value: string | null;
  sourceMemoryId: string;
}): Promise<boolean> {
  const [dupe] = await db
    .select({ id: knowledgeEdges.id })
    .from(knowledgeEdges)
    .where(
      and(
        eq(knowledgeEdges.projectId, edge.projectId),
        eq(knowledgeEdges.subject, edge.subject),
        eq(knowledgeEdges.predicate, edge.predicate),
        eq(knowledgeEdges.object, edge.object),
      ),
    )
    .limit(1);
  if (dupe) return false;
  await db.insert(knowledgeEdges).values(edge);
  return true;
}

/**
 * A knowledge edge, written unless the project already holds the same
 * (subject, predicate, object, value); answers the row and whether it was created. The dedup is
 * application-side so an extraction re-run on the same source memory stays idempotent.
 */
export async function createKnowledgeEdge(input: {
  projectId: string;
  subject: string;
  predicate: string;
  object: string;
  value?: string | null | undefined;
  sourceMemoryId?: string | null | undefined;
  confidence?: number | undefined;
  validFrom?: Date | null | undefined;
  validUntil?: Date | null | undefined;
}) {
  const valueCond = input.value
    ? eq(knowledgeEdges.value, input.value)
    : sql`${knowledgeEdges.value} IS NULL`;
  const [existing] = await db
    .select()
    .from(knowledgeEdges)
    .where(
      and(
        eq(knowledgeEdges.projectId, input.projectId),
        eq(knowledgeEdges.subject, input.subject),
        eq(knowledgeEdges.predicate, input.predicate),
        eq(knowledgeEdges.object, input.object),
        valueCond,
      ),
    )
    .limit(1);
  if (existing) return { row: existing, created: false };

  const [inserted] = await db
    .insert(knowledgeEdges)
    .values({
      projectId: input.projectId,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      value: input.value ?? null,
      sourceMemoryId: input.sourceMemoryId ?? null,
      confidence: input.confidence ?? 1.0,
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
    })
    .returning();
  if (!inserted) throw new Error('knowledge_edges: insert returned no row');
  return { row: inserted, created: true };
}

/** One knowledge edge, deleted. */
export async function deleteKnowledgeEdge(id: string): Promise<void> {
  await db.delete(knowledgeEdges).where(eq(knowledgeEdges.id, id));
}
