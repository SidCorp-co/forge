/**
 * What the steward's lifecycle steps read (ISS-1251 §4, §5): the lessons a landing invalidated, the
 * ones that hold and are owed a fold into their card, the ones drafted before anchors, and the past
 * failures a change to a lesson is replayed on.
 */

import { LESSON_FOLD_AFTER_APPLIED } from '@forge/contracts/lessons';
import { and, asc, eq, gt, inArray, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { corrections, lessonConfusions, lessons } from '../db/schema-lessons.js';

/** A lesson as the lifecycle steps weigh it. */
export interface LifecycleLesson {
  id: string;
  number: number;
  sentence: string;
  anchor: string | null;
  invalidBy: string | null;
  appliedCount: number;
  /** What each correction it came from said was wrong, oldest first: the failures it claims to fix. */
  failures: string[];
}

/** Each lesson's corrections, as said, oldest first. */
async function failuresOf(ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ lessonId: corrections.lessonId, reason: corrections.reason })
    .from(corrections)
    .where(inArray(corrections.lessonId, ids))
    .orderBy(asc(corrections.saidAt));
  for (const r of rows) {
    if (!r.lessonId) continue;
    out.set(r.lessonId, [...(out.get(r.lessonId) ?? []), r.reason]);
  }
  return out;
}

const COLUMNS = {
  id: lessons.id,
  number: lessons.number,
  sentence: lessons.sentence,
  anchor: lessons.anchor,
  invalidBy: lessons.invalidBy,
  appliedCount: lessons.appliedCount,
};

async function withFailures(rows: Omit<LifecycleLesson, 'failures'>[]): Promise<LifecycleLesson[]> {
  const failures = await failuresOf(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, failures: failures.get(r.id) ?? [] }));
}

/** The lessons a landing invalidated, held and owed the steward's re-check. */
export async function invalidatedLessons(projectId: string): Promise<LifecycleLesson[]> {
  const rows = await db
    .select(COLUMNS)
    .from(lessons)
    .where(
      and(
        eq(lessons.projectId, projectId),
        eq(lessons.status, 'held'),
        isNotNull(lessons.invalidAt),
      ),
    )
    .orderBy(asc(lessons.number));
  return withFailures(rows);
}

/**
 * The approved lessons that hold (§4): anchored to a card, applied `LESSON_FOLD_AFTER_APPLIED` times
 * or more, never corrected again since approved, with no confusion open on them and no application
 * marked wrong. Each is owed a fold into its card.
 */
export async function lessonsThatHold(projectId: string): Promise<LifecycleLesson[]> {
  const correctedSince = db
    .select({ id: corrections.id })
    .from(corrections)
    .where(and(eq(corrections.lessonId, lessons.id), gt(corrections.linkedAt, lessons.approvedAt)));
  // an open confusion, or an application marked wrong, says it does not hold; a settled one that kept
  // it (a re-anchor, a reading made clear) bars no fold, else no re-anchored lesson could ever fold
  const confused = db
    .select({ id: lessonConfusions.id })
    .from(lessonConfusions)
    .where(
      and(
        eq(lessonConfusions.lessonId, lessons.id),
        or(isNull(lessonConfusions.decidedAt), eq(lessonConfusions.kind, 'wrongly_applied')),
      ),
    );
  const rows = await db
    .select(COLUMNS)
    .from(lessons)
    .where(
      and(
        eq(lessons.projectId, projectId),
        eq(lessons.status, 'approved'),
        like(lessons.anchor, 'card:%'),
        sql`${lessons.appliedCount} >= ${LESSON_FOLD_AFTER_APPLIED}`,
        sql`NOT EXISTS ${correctedSince}`,
        sql`NOT EXISTS ${confused}`,
      ),
    )
    .orderBy(asc(lessons.number));
  return withFailures(rows);
}

/** The live lessons drafted before anchors, owed one from their record. */
export async function unanchoredLessons(projectId: string): Promise<LifecycleLesson[]> {
  const rows = await db
    .select(COLUMNS)
    .from(lessons)
    .where(
      and(
        eq(lessons.projectId, projectId),
        inArray(lessons.status, ['approved', 'held']),
        isNull(lessons.anchor),
      ),
    )
    .orderBy(asc(lessons.number));
  return withFailures(rows);
}
