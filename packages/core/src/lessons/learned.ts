/**
 * What a window taught (ISS-867): the lessons approved in it, and the approved lessons whose mistake
 * was made again in it, a correction said after the lesson's approval and linked to it by the
 * steward's lessons pass (`gather.ts:linkRepeats`). The daily review points its master here
 * (`masters/daily-review.ts:dailyReviewBrief`); the lessons themselves are read by slug from knowledge.
 */

import { type LessonsLearnedView, lessonKey } from '@forge/contracts/lessons';
import { and, asc, eq, gt, gte, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { corrections, lessons } from '../db/schema-lessons.js';
import { lessonEntrySlug } from '../knowledge/index.js';

export async function lessonsLearned(
  projectId: string,
  since: Date,
  until: Date,
): Promise<LessonsLearnedView> {
  const approved = await db
    .select({ number: lessons.number, approvedAt: lessons.approvedAt })
    .from(lessons)
    .where(
      and(
        eq(lessons.projectId, projectId),
        gte(lessons.approvedAt, since),
        lt(lessons.approvedAt, until),
      ),
    )
    .orderBy(asc(lessons.approvedAt), asc(lessons.number));
  const repeated = await db
    .select({
      number: lessons.number,
      count: sql<number>`count(*)::int`,
      items: sql<
        string[]
      >`array_agg(DISTINCT ${corrections.itemKey} ORDER BY ${corrections.itemKey})`,
    })
    .from(corrections)
    .innerJoin(lessons, eq(lessons.id, corrections.lessonId))
    .where(
      and(
        eq(corrections.projectId, projectId),
        gte(corrections.linkedAt, since),
        lt(corrections.linkedAt, until),
        gt(corrections.saidAt, lessons.approvedAt),
      ),
    )
    .groupBy(lessons.number)
    .orderBy(sql`count(*) DESC`, asc(lessons.number));
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    learned: approved.map((r) => ({
      key: lessonKey(r.number),
      slug: lessonEntrySlug(r.number),
      approvedAt: (r.approvedAt as Date).toISOString(),
    })),
    repeats: repeated.map((r) => ({
      key: lessonKey(r.number),
      slug: lessonEntrySlug(r.number),
      count: r.count,
      items: r.items,
    })),
  };
}
