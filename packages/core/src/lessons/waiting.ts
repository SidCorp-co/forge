/**
 * The lessons that wait on a person, as Needs you reads them (REQ-50 BC-2, BC-5, BC-7): each lesson
 * proposed or proposed for retirement, the corrections it came from, and each open confusion. Needs
 * you reads every project the person sees, so each of the three is one statement across them all
 * (`primeLessonsWaiting`, through `db/read-memo.ts:primeReads`) and costs a project no statement.
 */

import {
  type ConfusionView,
  type CorrectionView,
  type LessonView,
  lessonKey,
} from '@forge/contracts/lessons';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { memoizedRead, primeReads } from '../db/read-memo.js';
import { corrections, lessonConfusions, lessons } from '../db/schema-lessons.js';

/** A lesson a person decides, with only what its decision shows. */
export type WaitingLesson = Pick<
  LessonView,
  'id' | 'key' | 'sentence' | 'status' | 'proposedAt' | 'retire' | 'supersededBy'
> & {
  corrections: (Pick<CorrectionView, 'reason'> & { item: Pick<CorrectionView['item'], 'key'> })[];
};

/** An open confusion, with only what its decision shows. */
export type WaitingConfusion = Pick<
  ConfusionView,
  'id' | 'lessonKey' | 'kind' | 'other' | 'sides' | 'recommended' | 'raisedAgency' | 'raisedAt'
>;

const replacing = alias(lessons, 'replacing');
const against = alias(lessons, 'against');

/** Proposed, or approved with a retirement proposed: the two a person approves or turns down. */
const waits = or(
  eq(lessons.status, 'proposed'),
  and(
    eq(lessons.status, 'approved'),
    isNotNull(lessons.retireReason),
    isNotNull(lessons.retireProposedAt),
  ),
);

const lessonsKey = (projectId: string) => `lessons-waiting:${projectId}`;
const correctionsKey = (projectId: string) => `lessons-waiting-corrections:${projectId}`;
const confusionsKey = (projectId: string) => `lessons-open-confusions:${projectId}`;

const lessonRowsOf = (projectIds: readonly string[]) =>
  db
    .select({
      projectId: lessons.projectId,
      id: lessons.id,
      number: lessons.number,
      sentence: lessons.sentence,
      status: lessons.status,
      createdAt: lessons.createdAt,
      retireReason: lessons.retireReason,
      retireProposedAt: lessons.retireProposedAt,
      replacedBy: replacing.number,
    })
    .from(lessons)
    .leftJoin(replacing, eq(replacing.id, lessons.supersededById))
    .where(and(inArray(lessons.projectId, [...projectIds]), waits))
    .orderBy(desc(lessons.number));

const correctionRowsOf = (projectIds: readonly string[]) =>
  db
    .select({
      projectId: lessons.projectId,
      lessonId: corrections.lessonId,
      itemKey: corrections.itemKey,
      reason: corrections.reason,
    })
    .from(corrections)
    .innerJoin(lessons, eq(lessons.id, corrections.lessonId))
    .where(and(inArray(lessons.projectId, [...projectIds]), waits))
    .orderBy(asc(corrections.saidAt));

const confusionRowsOf = (projectIds: readonly string[]) =>
  db
    .select({
      projectId: lessonConfusions.projectId,
      id: lessonConfusions.id,
      number: lessons.number,
      kind: lessonConfusions.kind,
      againstNumber: against.number,
      otherRef: lessonConfusions.otherRef,
      sideLesson: lessonConfusions.sideLesson,
      sideOther: lessonConfusions.sideOther,
      recommended: lessonConfusions.recommended,
      recommendedSentence: lessonConfusions.recommendedSentence,
      raisedAgency: lessonConfusions.raisedAgency,
      raisedAt: lessonConfusions.raisedAt,
    })
    .from(lessonConfusions)
    .innerJoin(lessons, eq(lessons.id, lessonConfusions.lessonId))
    .leftJoin(against, eq(against.id, lessonConfusions.otherLessonId))
    .where(
      and(inArray(lessonConfusions.projectId, [...projectIds]), isNull(lessonConfusions.decidedAt)),
    )
    .orderBy(asc(lessonConfusions.raisedAt));

/** Reads what waits in every one of `projectIds` in three statements, for Needs you across them. */
export function primeLessonsWaiting(projectIds: readonly string[]): void {
  primeReads(projectIds, lessonsKey, lessonRowsOf, (r) => r.projectId);
  primeReads(projectIds, correctionsKey, correctionRowsOf, (r) => r.projectId);
  primeReads(projectIds, confusionsKey, confusionRowsOf, (r) => r.projectId);
}

/**
 * What waits on a person in `projectId`. The caller has read the viewer's access to the project and
 * offers these only to one who may decide them (`suggestions.approve`).
 */
export async function lessonsWaiting(
  projectId: string,
): Promise<{ lessons: WaitingLesson[]; confusions: WaitingConfusion[] }> {
  const [rows, said, open] = await Promise.all([
    memoizedRead(lessonsKey(projectId), () => lessonRowsOf([projectId])),
    memoizedRead(correctionsKey(projectId), () => correctionRowsOf([projectId])),
    memoizedRead(confusionsKey(projectId), () => confusionRowsOf([projectId])),
  ]);
  return {
    lessons: rows.map((r) => ({
      id: r.id,
      key: lessonKey(r.number),
      sentence: r.sentence,
      status: r.status,
      proposedAt: new Date(r.createdAt).toISOString(),
      retire:
        r.status === 'approved' && r.retireReason && r.retireProposedAt
          ? { reason: r.retireReason, at: new Date(r.retireProposedAt).toISOString() }
          : null,
      supersededBy: r.replacedBy ? lessonKey(r.replacedBy) : null,
      corrections: said
        .filter((c) => c.lessonId === r.id)
        .map((c) => ({ item: { key: c.itemKey }, reason: c.reason })),
    })),
    confusions: open.map((c) => ({
      id: c.id,
      lessonKey: lessonKey(c.number),
      kind: c.kind,
      other: { lessonKey: c.againstNumber ? lessonKey(c.againstNumber) : null, ref: c.otherRef },
      sides: { lesson: c.sideLesson, other: c.sideOther },
      recommended: {
        resolution: c.recommended as WaitingConfusion['recommended']['resolution'],
        sentence: c.recommendedSentence,
      },
      raisedAgency: c.raisedAgency,
      raisedAt: new Date(c.raisedAt).toISOString(),
    })),
  };
}
