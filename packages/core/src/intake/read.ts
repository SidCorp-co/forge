/**
 * An item's intake draft as its page reads it (`GET /api/projects/:id/intake-drafts/:ref`): REQ-n or
 * FB-n, the draft that stands for it, or null while none was made. An agent reads it through the
 * project's data policy like the item itself. The draft carries the item's value check, each question
 * with the answer given to it, the questions answered before it, and whether the viewer may answer
 * and keep the item (REQ-65 BC-1..BC-6).
 */

import { feedbackKey } from '@forge/contracts/feedback';
import {
  type IntakeAnsweredView,
  type IntakeDraftApplied,
  type IntakeDraftAssumption,
  type IntakeDraftLink,
  type IntakeDraftUnaffected,
  type IntakeDraftView,
  type IntakeItemKind,
  type IntakeQuestion,
  type IntakeQuestionView,
  type IntakeRead,
  intakeItemOfRef,
  type ValueCheckView,
} from '@forge/contracts/intake-drafts';
import type { ActorAgency } from '@forge/contracts/permissions';
import { requirementKey } from '@forge/contracts/requirements';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { type IntakeDraftRow, intakeAnswers, intakeDrafts } from '../db/schema-intake.js';
import { requirements } from '../db/schema-requirements.js';
import { egressForRequest } from '../lib/data-egress.js';
import { peopleOf } from '../lib/people.js';
import type { Refusal } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import { actorFor, can, projectResource, requireCan } from '../permissions/index.js';
import { answersOf } from './value.js';

export type IntakeReadOutcome =
  | { ok: true; draft: IntakeDraftView | null }
  | { ok: false; refusals: Refusal[] };

interface Body {
  links: IntakeDraftLink[];
  /** Absent on a draft kept before core offered the workflows an item touches. */
  notAffected?: IntakeDraftUnaffected[];
  assumptions: IntakeDraftAssumption[];
  questions: IntakeQuestion[];
  nothingToAsk: string | null;
}

/** The item a draft is of: its kind, key, author, and a requirement's status. */
export interface IntakeItemRef {
  kind: IntakeItemKind;
  id: string;
  key: string;
  authorId: string;
  status: string;
}

async function itemOf(
  projectId: string,
  kind: IntakeItemKind,
  seq: number,
): Promise<IntakeItemRef | null> {
  if (kind === 'requirement') {
    const [r] = await db
      .select({ id: requirements.id, status: requirements.status, ownerId: requirements.ownerId })
      .from(requirements)
      .where(and(eq(requirements.projectId, projectId), eq(requirements.reqSeq, seq)))
      .limit(1);
    return r
      ? { kind, id: r.id, key: requirementKey(seq), authorId: r.ownerId ?? '', status: r.status }
      : null;
  }
  const [f] = await db
    .select({ id: feedback.id, status: feedback.status, reportedBy: feedback.reportedBy })
    .from(feedback)
    .where(and(eq(feedback.projectId, projectId), eq(feedback.fbSeq, seq)))
    .limit(1);
  return f
    ? { kind, id: f.id, key: feedbackKey(seq), authorId: f.reportedBy, status: f.status }
    : null;
}

/** The item REQ-n or FB-n names in the project; a refusal for any other ref, and not found for none. */
export async function intakeItemIn(
  projectId: string,
  ref: string,
): Promise<{ ok: true; item: IntakeItemRef } | { ok: false; refusals: Refusal[] }> {
  const named = intakeItemOfRef(ref);
  if (!named) {
    return {
      ok: false,
      refusals: [
        {
          code: 'INTAKE_REF_INVALID',
          path: '/ref',
          detail: `"${ref.slice(0, 64)}" names no requirement or feedback item: send REQ-n or FB-n`,
        },
      ],
    };
  }
  const item = await itemOf(projectId, named.kind, named.seq);
  if (!item) {
    const key = named.kind === 'requirement' ? requirementKey(named.seq) : feedbackKey(named.seq);
    throw notFound(`project ${projectId} holds no ${key}`);
  }
  return { ok: true, item };
}

/** Whether `userId` may answer the item's questions: its author, or anyone who may write the project. */
export async function mayAnswer(projectId: string, item: IntakeItemRef, userId: string) {
  return (
    item.authorId === userId || can(actorFor(userId), 'project.write', projectResource(projectId))
  );
}

async function answeredOf(
  row: IntakeDraftRow,
  own: ReadonlySet<string>,
): Promise<IntakeAnsweredView[]> {
  const rows = await db
    .select()
    .from(intakeAnswers)
    .where(eq(intakeAnswers.draftId, row.id))
    .orderBy(asc(intakeAnswers.answeredAt));
  const before = rows.filter((a) => !own.has(a.id));
  const people = await peopleOf(before.map((a) => a.answeredBy));
  return before.map((a) => ({
    prompt: a.prompt,
    label: a.label,
    by: {
      id: a.answeredBy ?? '',
      name: a.answeredBy ? (people.get(a.answeredBy)?.name ?? null) : null,
    },
    at: a.answeredAt.toISOString(),
  }));
}

export async function viewOf(
  row: IntakeDraftRow,
  item: IntakeItemRef,
  may: IntakeDraftView['can'],
): Promise<IntakeDraftView> {
  const body = (row.body ?? null) as Body | null;
  const answers = await answersOf(db, row);
  const people = await peopleOf([...answers.values()].map((a) => a.answeredBy).concat(row.keptBy));
  const who = (id: string | null) => ({
    id: id ?? '',
    name: id ? (people.get(id)?.name ?? null) : null,
  });
  const questions: IntakeQuestionView[] = (body?.questions ?? []).map((q, i) => {
    const a = answers.get(i + 1);
    return {
      ...q,
      blocks: q.blocks ?? null,
      number: i + 1,
      answer: a
        ? {
            option: a.optionId,
            label: a.label,
            by: who(a.answeredBy),
            at: a.answeredAt.toISOString(),
          }
        : null,
    };
  });
  const value = (row.value ?? null) as Omit<ValueCheckView, 'kept'> | null;
  return {
    item: { kind: item.kind, key: item.key },
    outcome: row.outcome,
    code: row.code ?? null,
    detail: row.detail ?? null,
    at: row.draftedAt.toISOString(),
    model: row.model,
    attempts: row.attempts,
    retrying: row.retryOwed,
    read: row.read as Record<IntakeRead, number>,
    links: body?.links ?? [],
    notAffected: body?.notAffected ?? [],
    assumptions: body?.assumptions ?? [],
    questions,
    answered: await answeredOf(row, new Set([...answers.values()].map((a) => a.id))),
    nothingToAsk: body?.nothingToAsk ?? null,
    applied: (row.applied ?? null) as IntakeDraftApplied | null,
    value: value
      ? {
          ...value,
          effect: value.effect ?? null,
          kept:
            row.keptReason && row.keptAt
              ? { reason: row.keptReason, by: who(row.keptBy), at: row.keptAt.toISOString() }
              : null,
        }
      : null,
    can: may,
  };
}

export async function readIntakeDraft(input: {
  projectId: string;
  ref: string;
  viewer: { userId: string; agency: ActorAgency };
}): Promise<IntakeReadOutcome> {
  const { projectId, ref, viewer } = input;
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  const found = await intakeItemIn(projectId, ref);
  if (!found.ok) return found;
  const { item } = found;
  const [row] = await db
    .select()
    .from(intakeDrafts)
    .where(
      item.kind === 'requirement'
        ? eq(intakeDrafts.requirementId, item.id)
        : eq(intakeDrafts.feedbackId, item.id),
    )
    .limit(1);
  if (!row) return { ok: true, draft: null };
  const writes = await can(actorFor(viewer.userId), 'project.write', projectResource(projectId));
  const view = await viewOf(row, item, {
    answer: writes || item.authorId === viewer.userId,
    keep: writes && item.kind === 'requirement' && item.status === 'refused',
  });
  const surface = item.kind === 'feedback' ? 'feedback' : 'requirement';
  return {
    ok: true,
    draft: await egressForRequest(
      viewer.agency,
      projectId,
      surface,
      view,
      `the draft of ${item.key}`,
    ),
  };
}
