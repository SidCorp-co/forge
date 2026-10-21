/**
 * The monthly read (REQ-50 BC-8): in one calendar month (UTC), the corrections by source, the lessons
 * approved, the repeats (a correction linked to a lesson approved before it was said), and the
 * confusions with their time to decision. A confusion still open is counted to now.
 */

import {
  CORRECTION_SOURCES,
  type CorrectionSource,
  type LessonsMonthView,
  lessonKey,
} from '@forge/contracts/lessons';
import { and, eq, gte, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { corrections, lessonConfusions, lessons } from '../db/schema-lessons.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';

const HOUR_MS = 3_600_000;

function bounds(month: string | undefined, now: Date): { month: string; from: Date; to: Date } {
  const [y, m] = month
    ? month.split('-').map(Number)
    : [now.getUTCFullYear(), now.getUTCMonth() + 1];
  const from = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1));
  const to = new Date(Date.UTC(y ?? 1970, m ?? 1, 1));
  return {
    month: `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}`,
    from,
    to,
  };
}

export async function readLessonsMonth(input: {
  projectId: string;
  userId: string;
  month?: string | undefined;
  now?: Date;
}): Promise<LessonsMonthView> {
  const { projectId } = input;
  await requireCan(actorFor(input.userId), 'project.read', projectResource(projectId));
  const now = input.now ?? new Date();
  const { month, from, to } = bounds(input.month, now);
  const said = and(
    eq(corrections.projectId, projectId),
    gte(corrections.saidAt, from),
    lt(corrections.saidAt, to),
  );
  const [bySource, approved, repeats, confusions] = await Promise.all([
    db
      .select({ source: corrections.source, n: sql<number>`count(*)::int` })
      .from(corrections)
      .where(said)
      .groupBy(corrections.source),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(lessons)
      .where(
        and(
          eq(lessons.projectId, projectId),
          gte(lessons.approvedAt, from),
          lt(lessons.approvedAt, to),
        ),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(corrections)
      .innerJoin(lessons, eq(lessons.id, corrections.lessonId))
      .where(
        and(
          said,
          sql`${lessons.approvedAt} IS NOT NULL AND ${corrections.saidAt} > ${lessons.approvedAt}`,
        ),
      ),
    db
      .select({
        id: lessonConfusions.id,
        number: lessons.number,
        kind: lessonConfusions.kind,
        raisedAt: lessonConfusions.raisedAt,
        decidedAt: lessonConfusions.decidedAt,
      })
      .from(lessonConfusions)
      .innerJoin(lessons, eq(lessons.id, lessonConfusions.lessonId))
      .where(
        and(
          eq(lessonConfusions.projectId, projectId),
          or(
            and(gte(lessonConfusions.raisedAt, from), lt(lessonConfusions.raisedAt, to)),
            and(gte(lessonConfusions.decidedAt, from), lt(lessonConfusions.decidedAt, to)),
          ),
        ),
      )
      .orderBy(lessonConfusions.raisedAt),
  ]);
  const counts = Object.fromEntries(CORRECTION_SOURCES.map((s) => [s, 0])) as Record<
    CorrectionSource,
    number
  >;
  for (const row of bySource) counts[row.source] = row.n;
  const items = confusions.map((c) => ({
    id: c.id,
    lessonKey: lessonKey(c.number),
    kind: c.kind,
    raisedAt: c.raisedAt.toISOString(),
    decidedAt: c.decidedAt?.toISOString() ?? null,
    hours:
      Math.round((((c.decidedAt ?? now).getTime() - c.raisedAt.getTime()) / HOUR_MS) * 10) / 10,
  }));
  return {
    month,
    corrections: { total: bySource.reduce((sum, r) => sum + r.n, 0), bySource: counts },
    lessonsApproved: approved[0]?.n ?? 0,
    repeats: repeats[0]?.n ?? 0,
    confusions: {
      raised: confusions.filter((c) => c.raisedAt >= from && c.raisedAt < to).length,
      decided: confusions.filter((c) => c.decidedAt && c.decidedAt >= from && c.decidedAt < to)
        .length,
      open: confusions.filter((c) => !c.decidedAt).length,
      items,
    },
  };
}
