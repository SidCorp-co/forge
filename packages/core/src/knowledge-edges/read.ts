import { and, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEdges } from '../db/schema.js';

/** The project's knowledge edges matching the given parts, newest first. */
export async function listKnowledgeEdges(q: {
  projectId: string;
  subject?: string | undefined;
  predicate?: string | undefined;
  object?: string | undefined;
  limit: number;
}) {
  const conditions: SQL[] = [eq(knowledgeEdges.projectId, q.projectId)];
  if (q.subject) conditions.push(eq(knowledgeEdges.subject, q.subject));
  if (q.predicate) conditions.push(eq(knowledgeEdges.predicate, q.predicate));
  if (q.object) conditions.push(eq(knowledgeEdges.object, q.object));
  return db
    .select()
    .from(knowledgeEdges)
    .where(and(...conditions))
    .orderBy(desc(knowledgeEdges.createdAt))
    .limit(q.limit);
}

/** The project a knowledge edge belongs to; null when absent. */
export async function knowledgeEdgeProject(id: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: knowledgeEdges.projectId })
    .from(knowledgeEdges)
    .where(eq(knowledgeEdges.id, id))
    .limit(1);
  return row?.projectId ?? null;
}
