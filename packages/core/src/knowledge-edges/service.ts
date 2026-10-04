import { and, eq } from 'drizzle-orm';
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
