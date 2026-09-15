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

// cm:guard authorship is read off the row's OWN metadata and nothing else grants it: not project membership, not being in the room the note was written in. Two people in one conversation each see and delete only what was said on their behalf, and a room-wide read here would let anyone in it erase what the other asked to be remembered (ISS-1034 criteria 28, 30).
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

/** Remove one note the caller authored; false when no such row is theirs. */
// cm:guard a HARD delete, the same one `DELETE /api/memory/:id` makes, and not an archive: the person asked for the note to be gone, and an archived row still answers `includeArchived:true` reads and every revision listing — "no longer appears in forge_memory.search" has to be true of every reader, not the default one (ISS-1034 criterion 31).
export async function deleteMine(userId: string, id: string, dbi = defaultDb): Promise<boolean> {
  const removed = await dbi
    .delete(memories)
    .where(and(eq(memories.id, id), eq(memories.source, 'note'), authoredBy(userId)))
    .returning({ id: memories.id });
  return removed.length > 0;
}
