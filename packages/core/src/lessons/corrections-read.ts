/**
 * The corrections said in a window (ISS-867), newest first: what an agent reads to see that a room,
 * chat or feedback correction was kept, before the steward's lessons pass groups it into a lesson.
 * Read-only: linking, rejecting and grouping stay the steward's (`steward/lessons-pass.ts`).
 */

import {
  type CorrectionSource,
  LESSONS_CORRECTIONS_LIMIT,
  type LessonsCorrectionsView,
  lessonKey,
} from '@forge/contracts/lessons';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { corrections, lessons } from '../db/schema-lessons.js';

export async function correctionsSaid(
  projectId: string,
  since: Date,
  until: Date,
  source?: CorrectionSource,
): Promise<LessonsCorrectionsView> {
  const rows = await db
    .select({
      id: corrections.id,
      source: corrections.source,
      itemKind: corrections.itemKind,
      itemKey: corrections.itemKey,
      itemTitle: corrections.itemTitle,
      reason: corrections.reason,
      saidAt: corrections.saidAt,
      agency: corrections.agency,
      byUserId: corrections.byUserId,
      score: corrections.score,
      lessonNumber: lessons.number,
      rejectedAt: corrections.rejectedAt,
    })
    .from(corrections)
    .leftJoin(lessons, eq(lessons.id, corrections.lessonId))
    .where(
      and(
        eq(corrections.projectId, projectId),
        gte(corrections.saidAt, since),
        lt(corrections.saidAt, until),
        source ? eq(corrections.source, source) : undefined,
      ),
    )
    .orderBy(desc(corrections.saidAt), desc(corrections.id))
    .limit(LESSONS_CORRECTIONS_LIMIT + 1);
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    corrections: rows.slice(0, LESSONS_CORRECTIONS_LIMIT).map((r) => ({
      id: r.id,
      source: r.source,
      item: { kind: r.itemKind, key: r.itemKey, title: r.itemTitle },
      reason: r.reason,
      saidAt: r.saidAt.toISOString(),
      agency: r.agency,
      byUserId: r.byUserId,
      score: r.score,
      lesson: r.lessonNumber === null ? null : lessonKey(r.lessonNumber),
      rejected: r.rejectedAt !== null,
    })),
    truncated: rows.length > LESSONS_CORRECTIONS_LIMIT,
  };
}
