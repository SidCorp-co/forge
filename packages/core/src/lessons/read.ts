/**
 * The one read of a lesson the decisions take (REQ-50): a lesson by its number or uuid, refused by
 * name where the project holds none. Lessons are internal to Forge (BC-9): agents read the approved
 * ones in their prompts (`block.ts`), and no view of one is built for a screen.
 */

import { and, eq } from 'drizzle-orm';
import type { db, Tx } from '../db/client.js';
import { lessons } from '../db/schema-lessons.js';
import { refuse } from './refuse.js';

export type LessonRow = typeof lessons.$inferSelect;

/** One lesson by its number (`3`, `L-3`) or uuid, in this project. */
export async function lessonIn(
  executor: Tx | typeof db,
  projectId: string,
  ref: string,
): Promise<LessonRow> {
  const n = /^(?:L-)?(\d+)$/i.exec(ref.trim())?.[1];
  const byId = /^[0-9a-f-]{36}$/i.test(ref) ? eq(lessons.id, ref) : null;
  const where = n ? eq(lessons.number, Number(n)) : byId;
  const [row] = where
    ? await executor
        .select()
        .from(lessons)
        .where(and(eq(lessons.projectId, projectId), where))
        .limit(1)
    : [];
  if (!row) {
    throw refuse(
      'LESSON_NOT_FOUND',
      `project ${projectId} holds no lesson ${ref}; a lesson is named by its number (L-3 or 3) or its uuid`,
      '/lesson',
    );
  }
  return row;
}
