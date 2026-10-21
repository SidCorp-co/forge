/**
 * Confusions (REQ-50 BC-5): an agent that finds two lessons conflicting, a lesson contradicting a
 * requirement or design, or a lesson it cannot tell how to apply stops guessing and raises it, and a
 * person marking an application wrong raises one too. Raising holds the lesson in the same
 * transaction, so no prompt carries it from that moment; a holder of `suggestions.approve` decides:
 * keep it, edit it, or retire it.
 */

import { LESSON_MACHINE } from '@forge/contracts/lesson-machine';
import {
  type DecideConfusionRequest,
  type LessonView,
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
  type LessonActor,
  lockLessons,
  publishLesson,
  retireLessonIn,
  withdrawLessonEntry,
} from './decide.js';
import { type LessonRow, lessonIn, lessonViewOf } from './read.js';
import { refuse } from './refuse.js';

const kernelActor = (actor: LessonActor) => ({
  type: 'user' as const,
  id: actor.userId,
  agency: actor.agency,
});

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
  if (body.recommended.resolution === 'edit' && !body.recommended.sentence) {
    throw invalid(
      'recommending an edit says the sentence it recommends: recommended.sentence',
      '/recommended/sentence',
    );
  }
  return other;
}

/** An agent stops guessing: the confusion is kept, the lesson held until a person decides. */
export async function raiseConfusion(input: {
  projectId: string;
  ref: string;
  actor: LessonActor;
  body: RaiseConfusionRequest;
}): Promise<LessonView> {
  const { projectId, actor, body } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const id = await db.transaction(async (tx) => {
    await lockLessons(tx, projectId);
    const row = await lessonIn(tx, projectId, input.ref);
    refuseUnapplied(row);
    const other = await otherSide(tx, projectId, row, body);
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
      raisedBy: actor.userId,
      raisedAgency: actor.agency,
    });
    await hold(tx, row, actor, `${body.kind}: ${body.sides.other}`);
    return row.id;
  });
  return lessonViewOf(projectId, id, actor.userId);
}

/** A person says a lesson was wrongly applied to one output; that is a confusion about the lesson. */
export async function markWronglyApplied(input: {
  projectId: string;
  applicationId: string;
  actor: LessonActor;
  reason: string;
}): Promise<LessonView> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const id = await db.transaction(async (tx) => {
    await lockLessons(tx, projectId);
    const [app] = await tx
      .select()
      .from(lessonApplications)
      .where(
        and(
          eq(lessonApplications.projectId, projectId),
          eq(lessonApplications.id, input.applicationId),
        ),
      )
      .limit(1);
    if (!app) {
      throw refuse(
        'LESSON_NOT_FOUND',
        `project ${projectId} holds no applied lesson ${input.applicationId}`,
        '/application',
      );
    }
    const row = await lessonIn(tx, projectId, app.lessonId);
    if (app.wrongAt) {
      throw refuse(
        'LESSON_APPLICATION_MARKED',
        `this application of ${lessonKey(row.number)} was already marked wrongly applied`,
        '/application',
      );
    }
    const now = new Date();
    await tx
      .update(lessonApplications)
      .set({ wrongAt: now, wrongBy: actor.userId, wrongReason: input.reason })
      .where(eq(lessonApplications.id, app.id));
    if (row.status !== 'approved' && row.status !== 'held') return row.id;
    const said = `Wrongly applied to ${app.outputKind} ${app.outputRef}: ${input.reason}`;
    await tx.insert(lessonConfusions).values({
      projectId,
      lessonId: row.id,
      kind: 'wrongly_applied',
      sideLesson: row.sentence,
      sideOther: said.slice(0, 400),
      recommended: 'keep',
      applicationId: app.id,
      raisedBy: actor.userId,
      raisedAgency: actor.agency,
    });
    await hold(tx, row, actor, said);
    return row.id;
  });
  return lessonViewOf(projectId, id, actor.userId);
}

/** A person decides a confusion: keep the lesson, edit it, or retire it. */
export async function decideConfusion(input: {
  projectId: string;
  confusionId: string;
  actor: LessonActor;
  body: DecideConfusionRequest;
}): Promise<LessonView> {
  const { projectId, actor, body } = input;
  await requireCan(
    actorFor(actor.userId),
    'suggestions.approve',
    projectResource(projectId),
    'deciding a lesson confusion',
  );
  const id = await db.transaction(async (tx) => {
    await lockLessons(tx, projectId);
    const [confusion] = await tx
      .select()
      .from(lessonConfusions)
      .where(
        and(eq(lessonConfusions.projectId, projectId), eq(lessonConfusions.id, input.confusionId)),
      )
      .limit(1);
    if (!confusion) {
      throw refuse(
        'LESSON_NOT_FOUND',
        `project ${projectId} holds no lesson confusion ${input.confusionId}`,
        '/confusion',
      );
    }
    if (confusion.decidedAt) {
      throw refuse(
        'LESSON_CONFUSION_DECIDED',
        `this confusion was decided ${confusion.resolution} on ${confusion.decidedAt.toISOString()}`,
        '/confusion',
      );
    }
    const row = await lessonIn(tx, projectId, confusion.lessonId);
    const sentence =
      body.sentence ?? (body.resolution === 'edit' ? confusion.recommendedSentence : null);
    if (body.resolution === 'edit' && !sentence) {
      throw refuse(
        'LESSON_CONFUSION_INVALID',
        'an edit says the new sentence: sentence',
        '/sentence',
      );
    }
    await tx
      .update(lessonConfusions)
      .set({ decidedAt: new Date(), decidedBy: actor.userId, resolution: body.resolution })
      .where(eq(lessonConfusions.id, confusion.id));
    if (body.resolution === 'retire') {
      if (row.status === 'approved' || row.status === 'held') {
        await retireLessonIn(tx, row, actor, `Retired on a confusion: ${confusion.sideOther}`);
      }
      await closeOpenConfusions(tx, row.id, actor.userId, 'retire');
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
          actor: kernelActor(actor),
          source: 'lessons',
          returning: ['id'],
        }),
      );
      await publishLesson(tx, await lessonIn(tx, projectId, row.id));
    }
    return row.id;
  });
  return lessonViewOf(projectId, id, actor.userId);
}
