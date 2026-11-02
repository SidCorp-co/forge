// The lessons map a steward turn carries (REQ-50 BC-3): the slugs of the project's lessons, those about
// what its act produces and those about its item's area, read by the turn with `steward_read_lesson`
// (owner rule prompt-is-a-map); only an approved lesson is named.

import type { LessonItemKind } from '@forge/contracts/lessons';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { requirements } from '../db/schema-requirements.js';
import { type LessonAudience, lessonsMapFor } from '../lessons/index.js';
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
    fetch: 'the `steward_read_lesson` tool (its number)',
    list: 'the `steward_list_lessons` tool',
    raise: 'the `steward_raise_lesson_confusion` tool',
  };
  return lessonsMapFor(run.projectId, audience, 2);
}
