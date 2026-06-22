import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memoryCandidates } from '../db/schema.js';

export interface CandidatePage {
  items: typeof memoryCandidates.$inferSelect[];
  totalCount: number;
}

export async function listGraduatedCandidates(
  projectId: string,
  limit: number,
  offset: number,
): Promise<CandidatePage> {
  const where = and(
    eq(memoryCandidates.projectId, projectId),
    eq(memoryCandidates.status, 'graduated'),
    isNull(memoryCandidates.archivedAt),
  );

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(memoryCandidates)
      .where(where)
      .orderBy(desc(sql`${memoryCandidates.confidence}::numeric`), desc(memoryCandidates.graduatedAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(memoryCandidates).where(where),
  ]);

  const total = totalRows[0]?.total ?? 0;
  return { items: rows, totalCount: total };
}

export async function getCandidate(
  id: string,
): Promise<typeof memoryCandidates.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(memoryCandidates)
    .where(eq(memoryCandidates.id, id))
    .limit(1);
  return row ?? null;
}

export async function acceptCandidate(id: string): Promise<void> {
  await db
    .update(memoryCandidates)
    .set({ status: 'accepted', reviewedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(memoryCandidates.id, id));
}

export async function rejectCandidate(id: string): Promise<void> {
  await db
    .update(memoryCandidates)
    .set({
      status: 'rejected',
      archivedAt: sql`now()`,
      reviewedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(memoryCandidates.id, id));
}
