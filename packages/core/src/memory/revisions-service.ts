import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { memorySources } from '../db/schema.js';
import { memoryRevisions } from '../db/schema-memory-revisions.js';

/**
 * ISS-790. Reads the bodies a later write replaced — the "somewhere a person
 * can find" half of "if an entry is ever replaced, that fact is recorded".
 * Rows are minted by the `memories_record_replacement` trigger, never here.
 *
 * Does NOT check authorization — callers MUST verify project membership
 * before invoking.
 */

export const memoryRevisionsInputSchema = z.object({
  projectId: z.uuid(),
  memoryId: z.uuid().optional(),
  source: z.enum(memorySources).optional(),
  sourceRef: z.string().trim().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export type MemoryRevisionsInput = z.infer<typeof memoryRevisionsInputSchema>;

export interface MemoryRevisionRow {
  id: string;
  memoryId: string;
  source: string;
  sourceRef: string;
  textContent: string;
  metadata: unknown;
  replacedAt: Date;
}

export interface MemoryRevisionsResult {
  rows: MemoryRevisionRow[];
  total: number;
}

export async function runMemoryRevisions(
  input: MemoryRevisionsInput,
): Promise<MemoryRevisionsResult> {
  const conditions: SQL[] = [eq(memoryRevisions.projectId, input.projectId)];
  if (input.memoryId) conditions.push(eq(memoryRevisions.memoryId, input.memoryId));
  if (input.source) conditions.push(eq(memoryRevisions.source, input.source));
  if (input.sourceRef) conditions.push(eq(memoryRevisions.sourceRef, input.sourceRef));
  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(memoryRevisions)
    .where(where);

  const rows = await db
    .select({
      id: memoryRevisions.id,
      memoryId: memoryRevisions.memoryId,
      source: memoryRevisions.source,
      sourceRef: memoryRevisions.sourceRef,
      textContent: memoryRevisions.textContent,
      metadata: memoryRevisions.metadata,
      replacedAt: memoryRevisions.replacedAt,
    })
    .from(memoryRevisions)
    .where(where)
    .orderBy(desc(memoryRevisions.replacedAt))
    .limit(input.limit)
    .offset(input.offset);

  return { rows, total: Number(n) };
}
