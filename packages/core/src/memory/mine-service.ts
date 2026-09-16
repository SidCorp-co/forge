/**
 * ISS-1034 — a person's own notes: the `memories` rows `forge_memory.note`
 * wrote on their behalf, read and removed by the author and nobody else.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { memories } from '../db/schema.js';

export interface MineRow {
  id: string;
  projectId: string;
  textContent: string;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export const MINE_LIMIT = 200;

const authoredBy = (userId: string) =>
  sql`${memories.metadata} @> ${JSON.stringify({ authorUserId: userId })}::jsonb`;

/** Live notes the caller authored, newest first. */
export async function listMine(
  userId: string,
  opts: { projectId?: string | null | undefined } = {},
  dbi = defaultDb,
): Promise<MineRow[]> {
  return dbi
    .select({
      id: memories.id,
      projectId: memories.projectId,
      textContent: memories.textContent,
      metadata: memories.metadata,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .where(
      and(
        eq(memories.source, 'note'),
        authoredBy(userId),
        isNull(memories.archivedAt),
        ...(opts.projectId ? [eq(memories.projectId, opts.projectId)] : []),
      ),
    )
    .orderBy(desc(memories.createdAt))
    .limit(MINE_LIMIT);
}

/** One note the caller authored, by id, or null. */
export async function findMine(
  userId: string,
  id: string,
  dbi = defaultDb,
): Promise<{ id: string; projectId: string } | null> {
  const [row] = await dbi
    .select({ id: memories.id, projectId: memories.projectId })
    .from(memories)
    .where(and(eq(memories.id, id), eq(memories.source, 'note'), authoredBy(userId)))
    .limit(1);
  return row ?? null;
}

/** Remove one note the caller authored; false when no such row is theirs. */
export async function deleteMine(userId: string, id: string, dbi = defaultDb): Promise<boolean> {
  const removed = await dbi
    .delete(memories)
    .where(and(eq(memories.id, id), eq(memories.source, 'note'), authoredBy(userId)))
    .returning({ id: memories.id });
  return removed.length > 0;
}
