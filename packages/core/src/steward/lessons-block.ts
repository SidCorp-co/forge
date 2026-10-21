// The lessons a steward turn carries (REQ-50 BC-3): the project's, those about what its act produces,
// and those about its item's area, read from project knowledge so only an approved lesson is there.

import type { LessonItemKind } from '@forge/contracts/lessons';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { requirements } from '../db/schema-requirements.js';
import { type LessonAudience, lessonsBlockFor } from '../lessons/index.js';
import type { RunRow } from './runs-store.js';

const PRODUCES: Record<RunRow['subjectKind'], readonly LessonItemKind[]> = {
  requirement: ['requirement', 'suggestion'],
  feedback: ['suggestion', 'issue'],
  issue: ['issue'],
};

/** The area the run's item sits in: a requirement's own, an issue's requirement's, else none. */
async function areaOf(run: RunRow): Promise<string | null> {
  if (run.subjectKind === 'requirement') {
    const [row] = await db
      .select({ area: requirements.areaId })
      .from(requirements)
      .where(eq(requirements.id, run.subjectId));
    return row?.area ?? null;
  }
  if (run.subjectKind === 'issue') {
    const [row] = await db
      .select({ area: requirements.areaId })
      .from(issues)
      .innerJoin(requirements, eq(requirements.id, issues.requirementId))
      .where(eq(issues.id, run.subjectId));
    return row?.area ?? null;
  }
  return null;
}

export async function stewardLessonsBlock(run: RunRow): Promise<string | null> {
  const audience: LessonAudience = {
    produces: PRODUCES[run.subjectKind],
    area: await areaOf(run),
    raise: 'the `steward_raise_lesson_confusion` tool',
  };
  return lessonsBlockFor(run.projectId, audience, 2);
}
