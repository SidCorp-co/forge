/**
 * The reads of lessons (REQ-50): a lesson with its provenance, its applications and its open
 * confusions, the corrections no lesson holds yet, and every open confusion. Each view is built from
 * rows read here; nothing is cached.
 */

import {
  type ApplicationView,
  type ConfusionView,
  type CorrectionView,
  type LessonPerson,
  type LessonResolution,
  type LessonsResponse,
  type LessonView,
  lessonKey,
} from '@forge/contracts/lessons';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { conversationMessages } from '../db/schema-conversations.js';
import {
  corrections,
  lessonApplications,
  lessonConfusions,
  lessons,
} from '../db/schema-lessons.js';
import { requirementAreas } from '../db/schema-requirements.js';
import { issueDisplayIds } from '../issues/index.js';
import { peopleOf } from '../lib/people.js';
import { actorFor, can, projectResource, requireCan } from '../permissions/index.js';
import { refuse } from './refuse.js';

export type LessonRow = typeof lessons.$inferSelect;
type CorrectionRow = typeof corrections.$inferSelect;
type ConfusionRow = typeof lessonConfusions.$inferSelect;
type ApplicationRow = typeof lessonApplications.$inferSelect;

const UNLINKED_SHOWN = 50;

/** One lesson by its number (`3`, `L-3`) or uuid, in this project. */
export async function lessonIn(executor: Tx | typeof db, projectId: string, ref: string) {
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

type People = Map<string, { name: string }>;
const person = (people: People, id: string | null): LessonPerson | null =>
  id ? { id, name: people.get(id)?.name ?? null } : null;

function correctionView(
  row: CorrectionRow,
  people: People,
  keys: Map<string, number>,
): CorrectionView {
  const number = row.lessonId ? keys.get(row.lessonId) : undefined;
  return {
    id: row.id,
    source: row.source,
    item: { kind: row.itemKind, id: row.itemId, key: row.itemKey, title: row.itemTitle },
    reason: row.reason,
    by: person(people, row.byUserId),
    agency: row.agency,
    at: row.saidAt.toISOString(),
    lessonKey: number ? lessonKey(number) : null,
    score: row.score,
    dismissed: row.dismissedAt !== null,
  };
}

function confusionView(
  row: ConfusionRow,
  people: People,
  keys: Map<string, number>,
): ConfusionView {
  const other = row.otherLessonId ? keys.get(row.otherLessonId) : undefined;
  return {
    id: row.id,
    lessonKey: lessonKey(keys.get(row.lessonId) ?? 0),
    kind: row.kind,
    other: { lessonKey: other ? lessonKey(other) : null, ref: row.otherRef },
    sides: { lesson: row.sideLesson, other: row.sideOther },
    recommended: {
      resolution: row.recommended as LessonResolution,
      sentence: row.recommendedSentence,
    },
    raisedBy: person(people, row.raisedBy),
    raisedAgency: row.raisedAgency,
    raisedAt: row.raisedAt.toISOString(),
    decidedBy: person(people, row.decidedBy),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    resolution: (row.resolution as LessonResolution | null) ?? null,
  };
}

function applicationView(row: ApplicationRow, people: People, number: number): ApplicationView {
  return {
    id: row.id,
    lessonKey: lessonKey(number),
    output: { kind: row.outputKind, ref: row.outputRef },
    agent: person(people, row.agentUserId),
    at: row.at.toISOString(),
    wrong:
      row.wrongAt && row.wrongReason
        ? {
            by: person(people, row.wrongBy),
            at: row.wrongAt.toISOString(),
            reason: row.wrongReason,
          }
        : null,
  };
}

interface Around {
  corrections: CorrectionRow[];
  confusions: ConfusionRow[];
  applications: ApplicationRow[];
  keys: Map<string, number>;
  areas: Map<string, string>;
  issueKeys: Map<string, string>;
  people: People;
}

async function around(
  projectId: string,
  rows: LessonRow[],
  extra: CorrectionRow[],
): Promise<Around> {
  const ids = rows.map((r) => r.id);
  const [linked, confusions, applications, all, areas] = await Promise.all([
    ids.length
      ? db
          .select()
          .from(corrections)
          .where(inArray(corrections.lessonId, ids))
          .orderBy(asc(corrections.saidAt))
      : [],
    db
      .select()
      .from(lessonConfusions)
      .where(eq(lessonConfusions.projectId, projectId))
      .orderBy(asc(lessonConfusions.raisedAt)),
    ids.length
      ? db
          .select()
          .from(lessonApplications)
          .where(inArray(lessonApplications.lessonId, ids))
          .orderBy(desc(lessonApplications.at))
      : [],
    db
      .select({ id: lessons.id, number: lessons.number })
      .from(lessons)
      .where(eq(lessons.projectId, projectId)),
    db
      .select({ id: requirementAreas.id, name: requirementAreas.name })
      .from(requirementAreas)
      .where(eq(requirementAreas.projectId, projectId)),
  ]);
  const checks = rows.flatMap((r) => (r.checkIssueId ? [r.checkIssueId] : []));
  const people = await peopleOf([
    ...rows.flatMap((r) => [r.proposedBy, r.approvedBy]),
    ...[...linked, ...extra].map((c) => c.byUserId),
    ...confusions.flatMap((c) => [c.raisedBy, c.decidedBy]),
    ...applications.flatMap((a) => [a.agentUserId, a.wrongBy]),
  ]);
  return {
    corrections: linked,
    confusions,
    applications,
    keys: new Map(all.map((l) => [l.id, l.number])),
    areas: new Map(areas.map((a) => [a.id, a.name])),
    issueKeys: checks.length ? await issueDisplayIds(checks) : new Map(),
    people,
  };
}

function lessonView(row: LessonRow, a: Around, canDecide: boolean): LessonView {
  const mine = a.corrections.filter((c) => c.lessonId === row.id);
  const key = (id: string | null) => {
    const n = id ? a.keys.get(id) : undefined;
    return n ? lessonKey(n) : null;
  };
  const open = row.status === 'proposed';
  const live = row.status === 'approved' || row.status === 'held';
  return {
    id: row.id,
    key: lessonKey(row.number),
    number: row.number,
    sentence: row.sentence,
    scope: {
      kind: row.scopeKind,
      areaId: row.scopeAreaId,
      areaName: row.scopeAreaId ? (a.areas.get(row.scopeAreaId) ?? null) : null,
      itemKind: row.scopeItemKind,
    },
    status: row.status,
    proposedBy: person(a.people, row.proposedBy),
    proposedAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    reason: row.decidedReason,
    corrections: mine.map((c) => correctionView(c, a.people, a.keys)),
    repeats: mine.filter((c) => row.approvedAt && c.saidAt > row.approvedAt).length,
    appliedCount: row.appliedCount,
    lastAppliedAt: row.lastAppliedAt?.toISOString() ?? null,
    retire:
      row.retireReason && row.retireProposedAt && row.status === 'approved'
        ? { reason: row.retireReason, at: row.retireProposedAt.toISOString() }
        : null,
    supersedes: key(row.supersedesId),
    supersededBy: key(row.supersededById),
    checkIssueKey: row.checkIssueId ? (a.issueKeys.get(row.checkIssueId) ?? null) : null,
    confusions: a.confusions
      .filter((c) => c.lessonId === row.id)
      .map((c) => confusionView(c, a.people, a.keys)),
    applications: a.applications
      .filter((p) => p.lessonId === row.id)
      .map((p) => applicationView(p, a.people, row.number)),
    can: {
      approve: canDecide && open,
      reject: canDecide && open,
      edit: canDecide && open,
      retire: canDecide && live,
      keep: canDecide && row.status === 'approved' && row.retireReason !== null,
    },
  };
}

/** Lesson views for rows of one project, as the viewer may act on them. */
export async function lessonViews(
  projectId: string,
  rows: LessonRow[],
  viewer: string,
): Promise<LessonView[]> {
  const [a, canDecide] = await Promise.all([
    around(projectId, rows, []),
    can(actorFor(viewer), 'suggestions.approve', projectResource(projectId)),
  ]);
  return rows.map((r) => lessonView(r, a, canDecide));
}

export async function lessonViewOf(
  projectId: string,
  id: string,
  viewer: string,
): Promise<LessonView> {
  const row = await lessonIn(db, projectId, id);
  const [view] = await lessonViews(projectId, [row], viewer);
  if (!view) throw new Error(`lessons: no view built for ${id}`);
  return view;
}

/** The Lessons page: every lesson, the corrections no lesson holds yet, and every open confusion. */
export async function readLessons(projectId: string, viewer: string): Promise<LessonsResponse> {
  await requireCan(actorFor(viewer), 'project.read', projectResource(projectId));
  const [rows, unlinked] = await Promise.all([
    db.select().from(lessons).where(eq(lessons.projectId, projectId)).orderBy(desc(lessons.number)),
    db
      .select()
      .from(corrections)
      .where(
        and(
          eq(corrections.projectId, projectId),
          isNull(corrections.lessonId),
          isNull(corrections.dismissedAt),
        ),
      )
      .orderBy(desc(corrections.saidAt))
      .limit(UNLINKED_SHOWN),
  ]);
  const [a, canDecide] = await Promise.all([
    around(projectId, rows, unlinked),
    can(actorFor(viewer), 'suggestions.approve', projectResource(projectId)),
  ]);
  return {
    lessons: rows.map((r) => lessonView(r, a, canDecide)),
    corrections: unlinked.map((c) => correctionView(c, a.people, a.keys)),
    confusions: a.confusions
      .filter((c) => c.decidedAt === null)
      .map((c) => confusionView(c, a.people, a.keys)),
    canDecide,
  };
}

/** The corrections kept from, and the lessons applied in, one conversation's messages: the lines
 *  the chat draws under a person's reply and under an assistant message. */
export async function chatLessonMarks(projectId: string, conversationId: string, viewer: string) {
  await requireCan(actorFor(viewer), 'project.read', projectResource(projectId));
  const messages = db
    .select({ id: sql<string>`${conversationMessages.id}::text` })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId));
  const [kept, applied] = await Promise.all([
    db
      .select({
        id: corrections.id,
        messageId: corrections.sourceRef,
        reason: corrections.reason,
        dismissed: corrections.dismissedAt,
      })
      .from(corrections)
      .where(
        and(
          eq(corrections.projectId, projectId),
          eq(corrections.source, 'chat'),
          eq(corrections.itemId, conversationId),
        ),
      ),
    db
      .select({
        id: lessonApplications.id,
        messageId: lessonApplications.outputRef,
        number: lessons.number,
        wrong: lessonApplications.wrongAt,
      })
      .from(lessonApplications)
      .innerJoin(lessons, eq(lessons.id, lessonApplications.lessonId))
      .where(
        and(
          eq(lessonApplications.projectId, projectId),
          eq(lessonApplications.outputKind, 'chat_message'),
          inArray(lessonApplications.outputRef, messages),
        ),
      ),
  ]);
  return {
    corrections: kept.map((k) => ({
      id: k.id,
      messageId: k.messageId,
      reason: k.reason,
      dismissed: k.dismissed !== null,
    })),
    applied: applied.map((p) => ({
      id: p.id,
      messageId: p.messageId,
      lessonKey: lessonKey(p.number),
      wrong: p.wrong !== null,
    })),
  };
}
