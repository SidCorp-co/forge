// A lesson's module (ISS-1256), set by the module map's placement door; a lesson is named `L-<n>`.

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { lessons } from '../db/schema-lessons.js';

/** Set lesson `number`'s module in the project; the module it had before, or undefined where no lesson is `number`. */
export async function setLessonModule(
  projectId: string,
  number: number,
  moduleId: string | null,
): Promise<{ previous: string | null; title: string } | undefined> {
  const where = and(eq(lessons.projectId, projectId), eq(lessons.number, number));
  const [before] = await db
    .select({ moduleId: lessons.moduleId, sentence: lessons.sentence })
    .from(lessons)
    .where(where);
  if (!before) return undefined;
  await db.update(lessons).set({ moduleId }).where(where);
  return { previous: before.moduleId, title: before.sentence };
}
