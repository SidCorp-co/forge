import type { LessonResolution } from '@forge/contracts/lessons';
import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { lessonConfusions } from '../db/schema-lessons.js';

/**
 * Settle every open confusion on a lesson the same way, with the steward's reason, as when it retires
 * the lesson itself.
 */
export async function closeOpenConfusions(
  tx: Tx,
  lessonId: string,
  userId: string,
  settled: { resolution: LessonResolution; reason: string },
): Promise<void> {
  await tx
    .update(lessonConfusions)
    .set({ decidedAt: new Date(), decidedBy: userId, ...settled })
    .where(and(eq(lessonConfusions.lessonId, lessonId), isNull(lessonConfusions.decidedAt)));
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
