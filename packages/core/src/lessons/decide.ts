/**
 * The decisions on a lesson (REQ-50 BC-2, BC-3, BC-7): the steward proposes one from corrections, and
 * the steward and core settle it, as the steward account holding `suggestions.approve`: approve it
 * (optionally edited), reject it, or retire it, each with a reason; no person is asked. Each runs in
 * one transaction under the project's lessons lock; a status moves only through the kernel, which
 * keeps the reason, and the lesson's knowledge entry moves with it, so what a prompt reads never runs
 * ahead of the decision.
 */

import { LESSON_MACHINE } from '@forge/contracts/lesson-machine';
import type { LessonScope, LessonStatus, ProposeLessonRequest } from '@forge/contracts/lessons';
import { lessonKey } from '@forge/contracts/lessons';
import { and, eq, inArray, max } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { corrections, lessons } from '../db/schema-lessons.js';
import { requirementAreas } from '../db/schema-requirements.js';
import { putLessonEntry, setLessonEntryInjection } from '../knowledge/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { closeOpenConfusions } from './confusion-close.js';
import { type LessonRow, lessonIn } from './read.js';
import { refuse } from './refuse.js';

export interface LessonActor {
  userId: string;
  agency: 'human' | 'agent';
}

/** A lesson as a decision leaves it. */
export interface LessonMoved {
  id: string;
  key: string;
  status: LessonStatus;
}

/** What the steward changes when it approves a proposal edited (BC-2). */
export interface LessonEdit {
  sentence?: string | undefined;
  scope?: LessonScope | undefined;
}

export const kernelActor = (actor: LessonActor) => ({
  type: 'user' as const,
  id: actor.userId,
  agency: actor.agency,
});

export const lockLessons = (tx: Tx, projectId: string) => lockXact(tx, 'lessons', projectId);

const requireDecider = (actor: LessonActor, projectId: string, act: string) =>
  requireCan(actorFor(actor.userId), 'suggestions.approve', projectResource(projectId), act);

async function movedOf(projectId: string, id: string): Promise<LessonMoved> {
  const row = await lessonIn(db, projectId, id);
  return { id: row.id, key: lessonKey(row.number), status: row.status };
}

/** The scope's columns, its area checked to be this project's. */
async function scopeColumns(tx: Tx, projectId: string, scope: LessonScope) {
  if (scope.kind === 'area') {
    const [area] = await tx
      .select({ id: requirementAreas.id })
      .from(requirementAreas)
      .where(and(eq(requirementAreas.projectId, projectId), eq(requirementAreas.id, scope.areaId)))
      .limit(1);
    if (!area) {
      throw refuse(
        'LESSON_SCOPE_INVALID',
        `area ${scope.areaId} is not one of this project's requirement areas; scope a lesson to one of them, to a kind of item, or to the project`,
        '/scope/areaId',
      );
    }
  }
  return {
    scopeKind: scope.kind,
    scopeAreaId: scope.kind === 'area' ? scope.areaId : null,
    scopeItemKind: scope.kind === 'item_kind' ? scope.itemKind : null,
  };
}

/** The metadata a lesson's knowledge entry carries, so a prompt scopes it without this table. */
async function entryMeta(tx: Tx, row: LessonRow) {
  const [area] = row.scopeAreaId
    ? await tx
        .select({ name: requirementAreas.name })
        .from(requirementAreas)
        .where(eq(requirementAreas.id, row.scopeAreaId))
    : [];
  return {
    lessonId: row.id,
    number: row.number,
    scope: {
      kind: row.scopeKind,
      areaId: row.scopeAreaId,
      areaName: area?.name ?? null,
      itemKind: row.scopeItemKind,
    },
  };
}

/** Write an approved lesson's entry as it now reads. */
export async function publishLesson(tx: Tx, row: LessonRow): Promise<void> {
  await putLessonEntry(tx, {
    projectId: row.projectId,
    sentence: row.sentence,
    injection: 'always',
    meta: await entryMeta(tx, row),
  });
}

/** Take a lesson out of every prompt, in the transaction that holds or retires it. */
export const withdrawLessonEntry = (tx: Tx, row: LessonRow) =>
  setLessonEntryInjection(tx, row.projectId, row.number, 'none');

function refuseUnless(row: LessonRow, allowed: readonly LessonRow['status'][], act: string): void {
  if (allowed.includes(row.status)) return;
  throw refuse(
    'LESSON_DECIDED',
    `${lessonKey(row.number)} is ${row.status}; ${act} takes a lesson that is ${allowed.join(' or ')}`,
    '/lesson',
  );
}

/** The steward's proposal, grouping the corrections it learns from. */
export async function proposeLesson(input: {
  projectId: string;
  actor: LessonActor;
  body: ProposeLessonRequest;
}): Promise<LessonMoved> {
  const { projectId, actor, body } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const id = await db.transaction(async (tx) => {
    await lockLessons(tx, projectId);
    const scope = await scopeColumns(tx, projectId, body.scope);
    const wanted = [...new Set(body.corrections)];
    const found = await tx
      .select({
        id: corrections.id,
        lessonId: corrections.lessonId,
      })
      .from(corrections)
      .where(and(eq(corrections.projectId, projectId), inArray(corrections.id, wanted)));
    const free = new Set(found.filter((c) => !c.lessonId).map((c) => c.id));
    const bad = wanted.filter((c) => !free.has(c));
    if (bad.length > 0) {
      throw refuse(
        'LESSON_CORRECTIONS_INVALID',
        `a proposal learns from this project's corrections that no lesson holds yet; ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not one`,
        '/corrections',
      );
    }
    const supersedes = body.supersedes
      ? await lessonIn(tx, projectId, String(body.supersedes))
      : null;
    if (supersedes) refuseUnless(supersedes, ['approved', 'held'], 'superseding');
    const [top] = await tx
      .select({ n: max(lessons.number) })
      .from(lessons)
      .where(eq(lessons.projectId, projectId));
    const [row] = await tx
      .insert(lessons)
      .values({
        projectId,
        number: (top?.n ?? 0) + 1,
        sentence: body.sentence,
        ...scope,
        proposedBy: actor.userId,
        proposedAgency: actor.agency,
        supersedesId: supersedes?.id ?? null,
      })
      .returning({ id: lessons.id });
    if (!row) throw new Error('lessons: a proposal inserted no row');
    await tx
      .update(corrections)
      .set({ lessonId: row.id, linkedAt: new Date() })
      .where(inArray(corrections.id, wanted));
    return row.id;
  });
  return movedOf(projectId, id);
}

/**
 * Approve a proposal, as edited where `edit` edits it, saying why; from now its text reaches every
 * agent in its scope. The lesson it supersedes is retired in the same transaction (BC-7).
 */
export async function approveLesson(input: {
  projectId: string;
  ref: string;
  actor: LessonActor;
  edit?: LessonEdit | undefined;
  reason: string;
}): Promise<LessonMoved> {
  await requireDecider(input.actor, input.projectId, 'approving a lesson');
  const id = await db.transaction(async (tx) => {
    await lockLessons(tx, input.projectId);
    const row = await lessonIn(tx, input.projectId, input.ref);
    refuseUnless(row, ['proposed'], 'approving');
    const edits = {
      ...(input.edit?.sentence ? { sentence: input.edit.sentence } : {}),
      ...(input.edit?.scope ? await scopeColumns(tx, input.projectId, input.edit.scope) : {}),
    };
    const now = new Date();
    movedRow(
      await transition(tx, LESSON_MACHINE, {
        to: 'approved',
        expect: 'proposed',
        set: { ...edits, approvedAt: now, approvedBy: input.actor.userId, updatedAt: now },
        where: eq(lessons.id, row.id),
        reason: input.reason,
        actor: kernelActor(input.actor),
        source: 'lessons',
        returning: ['id'],
      }),
    );
    await publishLesson(tx, await lessonIn(tx, input.projectId, row.id));
    if (row.supersedesId) {
      const old = await lessonIn(tx, input.projectId, row.supersedesId);
      await tx
        .update(lessons)
        .set({ supersededById: row.id, updatedAt: now })
        .where(eq(lessons.id, old.id));
      if (old.status === 'approved' || old.status === 'held') {
        const reason = `Superseded by ${lessonKey(row.number)}.`;
        await retireLessonIn(tx, old, input.actor, reason);
        await closeOpenConfusions(tx, old.id, input.actor.userId, { resolution: 'retire', reason });
      }
    }
    return row.id;
  });
  return movedOf(input.projectId, id);
}

/** Reject a proposal, saying why; it never reaches a prompt, and its corrections stay its provenance. */
export async function rejectLesson(input: {
  projectId: string;
  ref: string;
  actor: LessonActor;
  reason: string;
}): Promise<LessonMoved> {
  await requireDecider(input.actor, input.projectId, 'rejecting a lesson');
  const id = await db.transaction(async (tx) => {
    await lockLessons(tx, input.projectId);
    const row = await lessonIn(tx, input.projectId, input.ref);
    refuseUnless(row, ['proposed'], 'rejecting');
    movedRow(
      await transition(tx, LESSON_MACHINE, {
        to: 'rejected',
        expect: 'proposed',
        set: { decidedReason: input.reason, updatedAt: new Date() },
        where: eq(lessons.id, row.id),
        reason: input.reason,
        actor: kernelActor(input.actor),
        source: 'lessons',
        returning: ['id'],
      }),
    );
    return row.id;
  });
  return movedOf(input.projectId, id);
}

/** Retire a lesson, approved or held; its row and its entry are kept, out of every prompt. */
export async function retireLessonIn(
  tx: Tx,
  row: LessonRow,
  actor: LessonActor,
  reason: string,
): Promise<void> {
  refuseUnless(row, ['approved', 'held'], 'retiring');
  movedRow(
    await transition(tx, LESSON_MACHINE, {
      to: 'retired',
      expect: row.status as 'approved' | 'held',
      set: { decidedReason: reason, updatedAt: new Date() },
      where: eq(lessons.id, row.id),
      reason,
      actor: kernelActor(actor),
      source: 'lessons',
      returning: ['id'],
    }),
  );
  await withdrawLessonEntry(tx, row);
}

/** Retire a lesson with a reason (BC-7); every confusion still open on it is settled with it. */
export async function retireLesson(input: {
  projectId: string;
  ref: string;
  actor: LessonActor;
  reason: string;
}): Promise<LessonMoved> {
  await requireDecider(input.actor, input.projectId, 'retiring a lesson');
  const id = await db.transaction(async (tx) => {
    await lockLessons(tx, input.projectId);
    const row = await lessonIn(tx, input.projectId, input.ref);
    await retireLessonIn(tx, row, input.actor, input.reason);
    await closeOpenConfusions(tx, row.id, input.actor.userId, {
      resolution: 'retire',
      reason: input.reason,
    });
    return row.id;
  });
  return movedOf(input.projectId, id);
}
