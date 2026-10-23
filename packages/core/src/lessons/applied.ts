/**
 * Applied lessons (REQ-50 BC-4): each output names the lessons that shaped it, and each is kept as
 * one application an agent can mark wrongly applied (`confusions.ts`). A run or a master records
 * them through the door; the assistant's reply and the steward's run are read for their
 * `Lessons applied:` line.
 * Only an approved lesson can be applied: a door naming any other is refused by name, and a line in
 * a model's text naming one is logged and left out.
 */

import {
  appliedLessonsIn,
  type LessonOutputKind,
  lessonKey,
  type RecordAppliedRequest,
} from '@forge/contracts/lessons';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { lessonApplications, lessons } from '../db/schema-lessons.js';
import { logger } from '../lib/logger.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { refuse } from './refuse.js';

interface Output {
  kind: LessonOutputKind;
  ref: string;
}

async function write(
  tx: Tx,
  projectId: string,
  ids: readonly { id: string }[],
  output: Output,
  agentUserId: string | null,
): Promise<number> {
  if (ids.length === 0) return 0;
  const now = new Date();
  const inserted = await tx
    .insert(lessonApplications)
    .values(
      ids.map((l) => ({
        projectId,
        lessonId: l.id,
        outputKind: output.kind,
        outputRef: output.ref,
        agentUserId,
        at: now,
      })),
    )
    .onConflictDoNothing({
      target: [
        lessonApplications.lessonId,
        lessonApplications.outputKind,
        lessonApplications.outputRef,
      ],
    })
    .returning({ lessonId: lessonApplications.lessonId });
  if (inserted.length > 0) {
    await tx
      .update(lessons)
      .set({ appliedCount: sql`${lessons.appliedCount} + 1`, lastAppliedAt: now })
      .where(
        inArray(
          lessons.id,
          inserted.map((r) => r.lessonId),
        ),
      );
  }
  return inserted.length;
}

async function approvedOf(executor: Tx | typeof db, projectId: string, numbers: readonly number[]) {
  if (numbers.length === 0) return [];
  return executor
    .select({ id: lessons.id, number: lessons.number })
    .from(lessons)
    .where(
      and(
        eq(lessons.projectId, projectId),
        eq(lessons.status, 'approved'),
        inArray(lessons.number, [...numbers]),
      ),
    );
}

/** The door: the lessons one output applied, each an approved lesson of this project. */
export async function recordApplied(input: {
  projectId: string;
  userId: string;
  body: RecordAppliedRequest;
}): Promise<{ recorded: number }> {
  const { projectId, userId, body } = input;
  await requireCan(actorFor(userId), 'project.write', projectResource(projectId));
  const numbers = [...new Set(body.lessons)];
  return db.transaction(async (tx) => {
    const found = await approvedOf(tx, projectId, numbers);
    const missing = numbers.filter((n) => !found.some((f) => f.number === n));
    if (missing.length > 0) {
      throw refuse(
        'LESSON_NOT_APPLICABLE',
        `only an approved lesson of this project is applied; ${missing.map(lessonKey).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not one (held, proposed, rejected, retired or absent)`,
        '/lessons',
      );
    }
    return { recorded: await write(tx, projectId, found, body.output, userId) };
  });
}

/** An agent's own text: the lessons its `Lessons applied:` line names, kept against its output. */
export async function recordAppliedFromText(input: {
  projectId: string;
  text: string;
  output: Output;
  agentUserId: string | null;
}): Promise<number> {
  const numbers = appliedLessonsIn(input.text);
  if (numbers.length === 0) return 0;
  return db.transaction(async (tx) => {
    const found = await approvedOf(tx, input.projectId, numbers);
    const left = numbers.filter((n) => !found.some((f) => f.number === n));
    if (left.length > 0) {
      logger.warn(
        { projectId: input.projectId, output: input.output, lessons: left.map(lessonKey) },
        'lessons: an output named lessons that are not approved; they were not recorded',
      );
    }
    return write(tx, input.projectId, found, input.output, input.agentUserId);
  });
}
