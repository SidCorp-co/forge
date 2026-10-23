import type { LessonResolution } from '@forge/contracts/lessons';
import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { lessonConfusions } from '../db/schema-lessons.js';

/** Settle every open confusion on a lesson the same way, as when the steward retires the lesson itself. */
export async function closeOpenConfusions(
  tx: Tx,
  lessonId: string,
  userId: string,
  resolution: LessonResolution,
  except?: string,
): Promise<void> {
  const open = and(eq(lessonConfusions.lessonId, lessonId), isNull(lessonConfusions.decidedAt));
  const rows = await tx.select({ id: lessonConfusions.id }).from(lessonConfusions).where(open);
  for (const row of rows) {
    if (row.id === except) continue;
    await tx
      .update(lessonConfusions)
      .set({ decidedAt: new Date(), decidedBy: userId, resolution })
      .where(eq(lessonConfusions.id, row.id));
  }
}

/** Whether a confusion other than `except` is still open on the lesson. */
export async function otherOpenConfusion(
  tx: Tx,
  lessonId: string,
  except: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: lessonConfusions.id })
    .from(lessonConfusions)
    .where(and(eq(lessonConfusions.lessonId, lessonId), isNull(lessonConfusions.decidedAt)));
  return rows.some((r) => r.id !== except);
}
