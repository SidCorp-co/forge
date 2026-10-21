/**
 * What the steward's lessons pass reads and writes here (REQ-50 BC-2, BC-6, BC-7): the corrections
 * no lesson holds yet beside the lessons that could hold them, a correction linked to the lesson it
 * repeats, the retirements now due, and the lessons owed a check. The pass itself, and the model it
 * asks, are the steward's (`steward/lessons-pass.ts`).
 */

import {
  LESSON_CHECK_AFTER,
  LESSON_UNUSED_DAYS,
  type LessonRetireReason,
} from '@forge/contracts/lessons';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { corrections, lessons } from '../db/schema-lessons.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';

const DAY_MS = 86_400_000;
const GATHER_CORRECTIONS = 40;

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

/**
 * Propose retiring each approved lesson that is superseded, or neither applied, approved nor kept in
 * the last `LESSON_UNUSED_DAYS` days (BC-7). A proposal is a mark a person answers; nothing retires.
 */
export async function proposeRetirements(projectId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - LESSON_UNUSED_DAYS * DAY_MS);
  const lastUse = sql`GREATEST(${lessons.approvedAt}, ${lessons.lastAppliedAt}, ${lessons.keptAt})`;
  const due = await db
    .select({ id: lessons.id, superseded: lessons.supersededById })
    .from(lessons)
    .where(
      and(
        eq(lessons.projectId, projectId),
        eq(lessons.status, 'approved'),
        isNull(lessons.retireReason),
        or(isNotNull(lessons.supersededById), sql`${lastUse} < ${sqlTimestamp(cutoff)}`),
      ),
    );
  for (const row of due) {
    const reason: LessonRetireReason = row.superseded ? 'superseded' : 'unused';
    await db
      .update(lessons)
      .set({ retireReason: reason, retireProposedAt: now, updatedAt: now })
      .where(and(eq(lessons.id, row.id), isNull(lessons.retireReason)));
  }
  return due.length;
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

/** The projects a lessons pass has work in: an unheld correction, or an approved lesson to age. */
export async function projectsWithLessonWork(): Promise<string[]> {
  const rows = await db.execute<{ project_id: string }>(sql`
    SELECT DISTINCT project_id FROM corrections WHERE lesson_id IS NULL AND dismissed_at IS NULL
    UNION
    SELECT DISTINCT project_id FROM lessons WHERE status = 'approved'`);
  return [...rows].map((r) => r.project_id);
}
