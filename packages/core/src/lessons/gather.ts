/**
 * What the steward's lessons pass reads and writes here (REQ-50 BC-2, BC-5..BC-7): the corrections
 * no lesson holds yet beside the lessons that could hold them, a correction linked to the lesson it
 * repeats, the proposals and open confusions it settles, the retirements now due, and the lessons
 * owed a check. The pass itself, and the model it asks, are the steward's (`steward/lessons-pass.ts`).
 */

import {
  LESSON_CHECK_AFTER,
  LESSON_UNUSED_DAYS,
  type LessonConfusionKind,
  type LessonResolution,
  type LessonRetireReason,
  type LessonScope,
  lessonKey,
} from '@forge/contracts/lessons';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { corrections, lessonConfusions, lessons } from '../db/schema-lessons.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';

const DAY_MS = 86_400_000;
const GATHER_CORRECTIONS = 40;
/**
 * Proposals, and confusions, the steward settles in one pass; the rest wait for the next. Each read
 * takes the lessons least recently touched first, and an attempt that settles nothing touches its
 * lesson (`deferLesson`), so it goes to the back: of W waiting, every one is reached within
 * ⌈W / SETTLE_PER_PASS⌉ passes, however many keep failing.
 */
const SETTLE_PER_PASS = 10;

export interface GatherCorrection {
  id: string;
  source: string;
  itemKind: string;
  itemKey: string;
  areaId: string | null;
  reason: string;
}

export interface GatherLesson {
  number: number;
  sentence: string;
  status: 'proposed' | 'approved';
  scope: string;
}

/** The corrections no lesson holds and nobody dismissed, oldest first, beside the live lessons. */
export async function gatherInput(
  projectId: string,
): Promise<{ corrections: GatherCorrection[]; lessons: GatherLesson[] }> {
  const [open, live] = await Promise.all([
    db
      .select({
        id: corrections.id,
        source: corrections.source,
        itemKind: corrections.itemKind,
        itemKey: corrections.itemKey,
        areaId: corrections.areaId,
        reason: corrections.reason,
      })
      .from(corrections)
      .where(
        and(
          eq(corrections.projectId, projectId),
          isNull(corrections.lessonId),
          isNull(corrections.dismissedAt),
        ),
      )
      .orderBy(corrections.saidAt)
      .limit(GATHER_CORRECTIONS),
    db
      .select({
        number: lessons.number,
        sentence: lessons.sentence,
        status: lessons.status,
        scopeKind: lessons.scopeKind,
        scopeAreaId: lessons.scopeAreaId,
        scopeItemKind: lessons.scopeItemKind,
      })
      .from(lessons)
      .where(
        and(eq(lessons.projectId, projectId), inArray(lessons.status, ['proposed', 'approved'])),
      ),
  ]);
  return {
    corrections: open,
    lessons: live.map((l) => ({
      number: l.number,
      sentence: l.sentence,
      status: l.status as 'proposed' | 'approved',
      scope:
        l.scopeKind === 'project'
          ? 'project'
          : `${l.scopeKind}:${l.scopeAreaId ?? l.scopeItemKind}`,
    })),
  };
}

/** Link each correction to the live lesson it repeats; one already linked or dismissed is left. */
export async function linkRepeats(
  projectId: string,
  links: ReadonlyArray<{ correction: string; lesson: number }>,
): Promise<number> {
  let linked = 0;
  for (const link of links) {
    const [lesson] = await db
      .select({ id: lessons.id })
      .from(lessons)
      .where(
        and(
          eq(lessons.projectId, projectId),
          eq(lessons.number, link.lesson),
          inArray(lessons.status, ['proposed', 'approved']),
        ),
      );
    if (!lesson) continue;
    const moved = await db
      .update(corrections)
      .set({ lessonId: lesson.id, linkedAt: new Date() })
      .where(
        and(
          eq(corrections.projectId, projectId),
          eq(corrections.id, link.correction),
          isNull(corrections.lessonId),
          isNull(corrections.dismissedAt),
        ),
      )
      .returning({ id: corrections.id });
    linked += moved.length;
  }
  return linked;
}

export interface RetirementDue {
  number: number;
  reason: LessonRetireReason;
  /** The lesson that replaced it, for a superseded one. */
  supersededBy: number | null;
}

const replacing = alias(lessons, 'replacing');

/**
 * Each approved lesson the steward now retires (BC-7): superseded by another, or neither applied,
 * approved nor kept in the last `LESSON_UNUSED_DAYS` days. A held lesson waits for its confusion.
 */
export async function retirementsDue(projectId: string, now: Date): Promise<RetirementDue[]> {
  const cutoff = new Date(now.getTime() - LESSON_UNUSED_DAYS * DAY_MS);
  const lastUse = sql`GREATEST(${lessons.approvedAt}, ${lessons.lastAppliedAt}, ${lessons.keptAt})`;
  const due = await db
    .select({ number: lessons.number, supersededBy: replacing.number })
    .from(lessons)
    .leftJoin(replacing, eq(replacing.id, lessons.supersededById))
    .where(
      and(
        eq(lessons.projectId, projectId),
        eq(lessons.status, 'approved'),
        or(isNotNull(lessons.supersededById), sql`${lastUse} < ${sqlTimestamp(cutoff)}`),
      ),
    )
    .orderBy(asc(lessons.number));
  return due.map((d) => ({
    number: d.number,
    reason: d.supersededBy ? 'superseded' : 'unused',
    supersededBy: d.supersededBy,
  }));
}

const scopeOf = (
  row: Pick<typeof lessons.$inferSelect, 'scopeKind' | 'scopeAreaId' | 'scopeItemKind'>,
): LessonScope =>
  row.scopeKind === 'area' && row.scopeAreaId
    ? { kind: 'area', areaId: row.scopeAreaId }
    : row.scopeKind === 'item_kind' && row.scopeItemKind
      ? { kind: 'item_kind', itemKind: row.scopeItemKind }
      : { kind: 'project' };

export interface ProposedLesson {
  number: number;
  sentence: string;
  scope: LessonScope;
  supersedes: number | null;
  /** Each correction it was grouped from: the item it corrected and the reason as said. */
  corrections: { itemKey: string; reason: string }[];
}

/** The proposals waiting for the steward to settle, least recently tried first, with their corrections. */
export async function proposedLessons(projectId: string): Promise<ProposedLesson[]> {
  const superseded = alias(lessons, 'superseded');
  const rows = await db
    .select({
      id: lessons.id,
      number: lessons.number,
      sentence: lessons.sentence,
      scopeKind: lessons.scopeKind,
      scopeAreaId: lessons.scopeAreaId,
      scopeItemKind: lessons.scopeItemKind,
      supersedes: superseded.number,
    })
    .from(lessons)
    .leftJoin(superseded, eq(superseded.id, lessons.supersedesId))
    .where(and(eq(lessons.projectId, projectId), eq(lessons.status, 'proposed')))
    .orderBy(asc(lessons.updatedAt), asc(lessons.number))
    .limit(SETTLE_PER_PASS);
  const said = rows.length
    ? await db
        .select({
          lessonId: corrections.lessonId,
          itemKey: corrections.itemKey,
          reason: corrections.reason,
        })
        .from(corrections)
        .where(
          inArray(
            corrections.lessonId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(corrections.saidAt))
    : [];
  return rows.map((r) => ({
    number: r.number,
    sentence: r.sentence,
    scope: scopeOf(r),
    supersedes: r.supersedes,
    corrections: said
      .filter((c) => c.lessonId === r.id)
      .map((c) => ({ itemKey: c.itemKey, reason: c.reason })),
  }));
}

export interface OpenConfusion {
  id: string;
  kind: LessonConfusionKind;
  lesson: { number: number; sentence: string; scope: LessonScope };
  /** What it is held against: another lesson (its key and sentence), or a requirement, design or output ref. */
  other: { lesson: string | null; sentence: string | null; ref: string | null };
  sides: { lesson: string; other: string };
  recommended: { resolution: LessonResolution; sentence: string | null };
}

/** The confusions open on held lessons, least recently tried lesson first, then oldest raised. */
export async function openConfusions(projectId: string): Promise<OpenConfusion[]> {
  const against = alias(lessons, 'against');
  const rows = await db
    .select({
      id: lessonConfusions.id,
      kind: lessonConfusions.kind,
      number: lessons.number,
      sentence: lessons.sentence,
      scopeKind: lessons.scopeKind,
      scopeAreaId: lessons.scopeAreaId,
      scopeItemKind: lessons.scopeItemKind,
      againstNumber: against.number,
      againstSentence: against.sentence,
      otherRef: lessonConfusions.otherRef,
      sideLesson: lessonConfusions.sideLesson,
      sideOther: lessonConfusions.sideOther,
      recommended: lessonConfusions.recommended,
      recommendedSentence: lessonConfusions.recommendedSentence,
    })
    .from(lessonConfusions)
    .innerJoin(lessons, eq(lessons.id, lessonConfusions.lessonId))
    .leftJoin(against, eq(against.id, lessonConfusions.otherLessonId))
    .where(and(eq(lessonConfusions.projectId, projectId), isNull(lessonConfusions.decidedAt)))
    .orderBy(asc(lessons.updatedAt), asc(lessonConfusions.raisedAt))
    .limit(SETTLE_PER_PASS);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    lesson: { number: r.number, sentence: r.sentence, scope: scopeOf(r) },
    other: {
      lesson: r.againstNumber ? lessonKey(r.againstNumber) : null,
      sentence: r.againstSentence,
      ref: r.otherRef,
    },
    sides: { lesson: r.sideLesson, other: r.sideOther },
    recommended: {
      resolution: r.recommended as LessonResolution,
      sentence: r.recommendedSentence,
    },
  }));
}

/**
 * An attempt to settle the lesson, or a confusion on it, left it waiting: its `updated_at` moves to
 * now, so the next pass reaches the items behind it first. Its status and text are untouched.
 */
export async function deferLesson(projectId: string, number: number): Promise<void> {
  await db
    .update(lessons)
    .set({ updatedAt: new Date() })
    .where(and(eq(lessons.projectId, projectId), eq(lessons.number, number)));
}

export interface OwedCheck {
  id: string;
  number: number;
  sentence: string;
  reasons: string[];
  repeats: number;
}

/**
 * The approved lessons owed a check in code (BC-6): corrected again after approval, or corrected
 * `LESSON_CHECK_AFTER` times, and no check filed yet.
 */
export async function checksOwed(projectId: string): Promise<OwedCheck[]> {
  const rows = await db
    .select({
      id: lessons.id,
      number: lessons.number,
      sentence: lessons.sentence,
      approvedAt: lessons.approvedAt,
      reason: corrections.reason,
      saidAt: corrections.saidAt,
    })
    .from(lessons)
    .innerJoin(corrections, eq(corrections.lessonId, lessons.id))
    .where(
      and(
        eq(lessons.projectId, projectId),
        eq(lessons.status, 'approved'),
        isNull(lessons.checkIssueId),
      ),
    );
  const byLesson = new Map<string, OwedCheck>();
  for (const r of rows) {
    const owed = byLesson.get(r.id) ?? {
      id: r.id,
      number: r.number,
      sentence: r.sentence,
      reasons: [],
      repeats: 0,
    };
    owed.reasons.push(r.reason);
    if (r.approvedAt && r.saidAt > r.approvedAt) owed.repeats += 1;
    byLesson.set(r.id, owed);
  }
  return [...byLesson.values()].filter(
    (o) => o.repeats > 0 || o.reasons.length >= LESSON_CHECK_AFTER,
  );
}

/** The check filed for a lesson, kept so it is filed once. */
export async function recordCheckIssue(lessonId: string, issueId: string): Promise<void> {
  await db
    .update(lessons)
    .set({ checkIssueId: issueId, updatedAt: new Date() })
    .where(and(eq(lessons.id, lessonId), isNull(lessons.checkIssueId)));
}

/**
 * The projects a lessons pass has work in: an unheld correction, a proposal to settle, a held lesson
 * whose confusion waits, or an approved lesson to age.
 */
export async function projectsWithLessonWork(): Promise<string[]> {
  const rows = await db.execute<{ project_id: string }>(sql`
    SELECT DISTINCT project_id FROM corrections WHERE lesson_id IS NULL AND dismissed_at IS NULL
    UNION
    SELECT DISTINCT project_id FROM lessons WHERE status IN ('proposed', 'approved', 'held')`);
  return [...rows].map((r) => r.project_id);
}
