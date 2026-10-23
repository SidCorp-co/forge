/**
 * Confusions (REQ-50 BC-4, BC-5): an agent that finds two lessons conflicting, a lesson contradicting a
 * requirement or design, a lesson it cannot tell how to apply, or one wrongly applied to an output
 * stops guessing and reports it to the steward. Raising holds the lesson in the same transaction, so
 * no prompt carries it from that moment; the steward and core settle it (`steward/lessons-review.ts`):
 * keep it, edit it, or retire it, with a reason. No person is asked to decide one.
 */

import { LESSON_MACHINE } from '@forge/contracts/lesson-machine';
import {
  type LessonResolution,
  lessonKey,
  type RaiseConfusionRequest,
} from '@forge/contracts/lessons';
import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { lessonApplications, lessonConfusions, lessons } from '../db/schema-lessons.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { closeOpenConfusions, otherOpenConfusion } from './confusion-close.js';
import {
  kernelActor,
  type LessonActor,
  type LessonMoved,
  lockLessons,
  publishLesson,
  retireLessonIn,
  withdrawLessonEntry,
} from './decide.js';
import { type LessonRow, lessonIn } from './read.js';
import { refuse } from './refuse.js';

/** Approved → held, its entry out of every prompt; a lesson already held stays held. */
async function hold(tx: Tx, row: LessonRow, actor: LessonActor, why: string): Promise<void> {
  if (row.status !== 'approved') return;
  movedRow(
    await transition(tx, LESSON_MACHINE, {
      to: 'held',
      expect: 'approved',
      set: { updatedAt: new Date() },
      where: eq(lessons.id, row.id),
      reason: why,
      actor: kernelActor(actor),
      source: 'lessons',
      returning: ['id'],
    }),
  );
  await withdrawLessonEntry(tx, row);
}

function refuseUnapplied(row: LessonRow): void {
  if (row.status === 'approved' || row.status === 'held') return;
  throw refuse(
    'LESSON_DECIDED',
    `${lessonKey(row.number)} is ${row.status}: only an approved lesson reaches an agent, so only one can confuse it`,
    '/lesson',
  );
}

async function otherSide(tx: Tx, projectId: string, row: LessonRow, body: RaiseConfusionRequest) {
  const other = body.other?.lesson
    ? await lessonIn(tx, projectId, String(body.other.lesson))
    : null;
  const invalid = (detail: string, path: string) =>
    refuse('LESSON_CONFUSION_INVALID', detail, path);
  if (body.kind === 'conflict' && (!other || other.id === row.id)) {
    throw invalid(
      'a conflict names the other lesson it conflicts with: other.lesson, a lesson number other than this one',
      '/other/lesson',
    );
  }
  if (body.kind === 'contradicts' && !body.other?.ref) {
    throw invalid(
      'a contradiction names what the lesson contradicts: other.ref, a requirement (REQ-n) or a workflow design',
      '/other/ref',
    );
  }
  if (body.kind === 'wrongly_applied' && !body.other?.ref) {
    throw invalid(
      'a wrongly_applied confusion names the output the lesson was applied to: other.ref, the ref its application was recorded under',
      '/other/ref',
    );
  }
  if (body.recommended.resolution === 'edit' && !body.recommended.sentence) {
    throw invalid(
      'recommending an edit says the sentence it recommends: recommended.sentence',
      '/recommended/sentence',
    );
  }
  return other;
}

/**
 * The application a `wrongly_applied` confusion marks (BC-4): the lesson's recorded application to the
 * output `other.ref` names, refused by name where none was recorded or one was marked already.
 */
async function markApplication(
  tx: Tx,
  row: LessonRow,
  outputRef: string,
  actor: LessonActor,
  reason: string,
): Promise<string> {
  const [app] = await tx
    .select({ id: lessonApplications.id, wrongAt: lessonApplications.wrongAt })
    .from(lessonApplications)
    .where(
      and(eq(lessonApplications.lessonId, row.id), eq(lessonApplications.outputRef, outputRef)),
    )
    .limit(1);
  if (!app) {
    throw refuse(
      'LESSON_CONFUSION_INVALID',
      `no application of ${lessonKey(row.number)} to ${outputRef} is recorded; a wrongly_applied confusion names, in other.ref, an output the lesson was recorded applied to (POST …/lessons/applied)`,
      '/other/ref',
    );
  }
  if (app.wrongAt) {
    throw refuse(
      'LESSON_APPLICATION_MARKED',
      `the application of ${lessonKey(row.number)} to ${outputRef} was already marked wrongly applied`,
      '/other/ref',
    );
  }
  await tx
    .update(lessonApplications)
    .set({ wrongAt: new Date(), wrongBy: actor.userId, wrongReason: reason })
    .where(eq(lessonApplications.id, app.id));
  return app.id;
}

/** An agent stops guessing: the confusion is kept, the lesson held until the steward settles it. */
export async function raiseConfusion(input: {
  projectId: string;
  ref: string;
  actor: LessonActor;
  body: RaiseConfusionRequest;
}): Promise<LessonMoved> {
  const { projectId, actor, body } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  return db.transaction(async (tx) => {
    await lockLessons(tx, projectId);
    const row = await lessonIn(tx, projectId, input.ref);
    refuseUnapplied(row);
    const other = await otherSide(tx, projectId, row, body);
    const applicationId =
      body.kind === 'wrongly_applied' && body.other?.ref
        ? await markApplication(tx, row, body.other.ref, actor, body.sides.other)
        : null;
    await tx.insert(lessonConfusions).values({
      projectId,
      lessonId: row.id,
      kind: body.kind,
      otherLessonId: other?.id ?? null,
      otherRef: body.other?.ref ?? null,
      sideLesson: body.sides.lesson,
      sideOther: body.sides.other,
      recommended: body.recommended.resolution,
      recommendedSentence: body.recommended.sentence ?? null,
      applicationId,
      raisedBy: actor.userId,
      raisedAgency: actor.agency,
    });
    await hold(tx, row, actor, `${body.kind}: ${body.sides.other}`);
    return { id: row.id, key: lessonKey(row.number), status: 'held' as const };
  });
}

/** How the steward settles one confusion, and why (BC-5). */
export interface ConfusionSettlement {
  resolution: LessonResolution;
  /** The new sentence for an edit; the raiser's recommended one where absent. */
  sentence?: string | undefined;
  reason: string;
}

async function openConfusionIn(tx: Tx, projectId: string, confusionId: string) {
  const [confusion] = await tx
    .select()
    .from(lessonConfusions)
    .where(and(eq(lessonConfusions.projectId, projectId), eq(lessonConfusions.id, confusionId)))
    .limit(1);
  if (!confusion) {
    throw refuse(
      'LESSON_NOT_FOUND',
      `project ${projectId} holds no lesson confusion ${confusionId}`,
      '/confusion',
    );
  }
  if (confusion.decidedAt) {
    throw refuse(
      'LESSON_CONFUSION_DECIDED',
      `this confusion was settled ${confusion.resolution} on ${confusion.decidedAt.toISOString()}`,
      '/confusion',
    );
  }
  return confusion;
}

/**
 * The steward settles a confusion: keep the lesson, edit it, or retire it, with a reason the kernel
 * keeps on the lesson's move. A lesson still held by another open confusion stays held.
 */
export async function decideConfusion(input: {
  projectId: string;
  confusionId: string;
  actor: LessonActor;
  settle: ConfusionSettlement;
}): Promise<LessonMoved> {
  const { projectId, actor, settle } = input;
  await requireCan(
    actorFor(actor.userId),
    'suggestions.approve',
    projectResource(projectId),
    'settling a lesson confusion',
  );
  const id = await db.transaction(async (tx) => {
    await lockLessons(tx, projectId);
    const confusion = await openConfusionIn(tx, projectId, input.confusionId);
    const row = await lessonIn(tx, projectId, confusion.lessonId);
    const sentence =
      settle.sentence ?? (settle.resolution === 'edit' ? confusion.recommendedSentence : null);
    if (settle.resolution === 'edit' && !sentence) {
      throw refuse(
        'LESSON_CONFUSION_INVALID',
        'an edit says the new sentence: sentence',
        '/sentence',
      );
    }
    await tx
      .update(lessonConfusions)
      .set({
        decidedAt: new Date(),
        decidedBy: actor.userId,
        resolution: settle.resolution,
        reason: settle.reason,
      })
      .where(eq(lessonConfusions.id, confusion.id));
    if (settle.resolution === 'retire') {
      if (row.status === 'approved' || row.status === 'held') {
        await retireLessonIn(tx, row, actor, settle.reason);
      }
      await closeOpenConfusions(tx, row.id, actor.userId, {
        resolution: 'retire',
        reason: settle.reason,
      });
      return row.id;
    }
    if (sentence) {
      await tx
        .update(lessons)
        .set({ sentence, updatedAt: new Date() })
        .where(eq(lessons.id, row.id));
    }
    if (row.status === 'held' && !(await otherOpenConfusion(tx, row.id, confusion.id))) {
      movedRow(
        await transition(tx, LESSON_MACHINE, {
          to: 'approved',
          expect: 'held',
          set: { updatedAt: new Date() },
          where: eq(lessons.id, row.id),
          reason: settle.reason,
          actor: kernelActor(actor),
          source: 'lessons',
          returning: ['id'],
        }),
      );
      await publishLesson(tx, await lessonIn(tx, projectId, row.id));
    } else if (sentence && row.status === 'approved') {
      await publishLesson(tx, await lessonIn(tx, projectId, row.id));
    }
    return row.id;
  });
  const after = await lessonIn(db, projectId, id);
  return { id, key: lessonKey(after.number), status: after.status };
}
