import {
  type FeedbackDecisionView,
  type FeedbackMessageView,
  type FeedbackPhase,
  type FeedbackVerifiedView,
  type FeedbackView,
  feedbackKey,
} from '@forge/contracts/feedback';
import type { ActorAgency } from '@forge/contracts/permissions';
import { requirementKey } from '@forge/contracts/requirements';
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import {
  feedback,
  feedbackAttachments,
  feedbackDecisions,
  feedbackMessages,
} from '../db/schema-feedback.js';
import { agentQuestions } from '../db/schema-questions.js';
import { suggestions } from '../db/schema-suggestions.js';
import { findIssueById, isUuid } from '../issues/index.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { userNames } from '../lib/people.js';
import { notFound } from '../middleware/route-errors.js';
import { actorFor, holds, projectResource, requireCan } from '../permissions/index.js';
import { rowIn as requirementRowIn } from '../requirements/index.js';
import { feedbackEgress, type ReadDoor, WITHHELD } from './egress.js';
import { autoVerifyOf, linkedOf, summaryOf, viewerCanOf } from './list-read.js';
import { sourceOf } from './relations.js';
import { reportersOf } from './reporters.js';
import { shipNoticeOf } from './ship-notice.js';

export interface FeedbackActor {
  userId: string;
  agency: ActorAgency;
}

export type Row = typeof feedback.$inferSelect;

/** An item of `projectId` by uuid, `FB-n` or `n`, locked for update when asked; 404 otherwise. */
export async function rowIn(tx: Tx, projectId: string, ref: string, lock = false): Promise<Row> {
  const seq = /^(?:FB-)?(\d{1,9})$/i.exec(ref.trim())?.[1];
  const uuid = isUuid(ref) ? ref : null;
  if (!seq && !uuid) throw notFound(`"${ref}" is neither a feedback uuid nor a key like FB-12`);
  const query = tx
    .select()
    .from(feedback)
    .where(
      and(
        eq(feedback.projectId, projectId),
        seq ? eq(feedback.fbSeq, Number(seq)) : eq(feedback.id, uuid as string),
      ),
    );
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw notFound(`project ${projectId} holds no feedback ${ref}`);
  return row;
}

/** The keys of the items marked duplicates of `feedbackId`, oldest first. */
export async function duplicateKeysOf(tx: Tx, feedbackId: string): Promise<string[]> {
  const rows = await tx
    .select({ seq: feedback.fbSeq })
    .from(feedback)
    .where(eq(feedback.duplicateOf, feedbackId))
    .orderBy(asc(feedback.fbSeq));
  return rows.map((r) => feedbackKey(r.seq));
}

export interface TargetRequirement {
  id: string;
  key: string;
  status: string;
}

/** The requirement an item is about: its target, or the requirement its target issue delivers. */
export async function targetRequirementOf(tx: Tx, row: Row): Promise<TargetRequirement | null> {
  const id =
    row.requirementId ??
    (row.issueId ? ((await findIssueById(row.issueId))?.requirementId ?? null) : null);
  if (!id) return null;
  const req = await requirementRowIn(tx, row.projectId, id);
  return { id: req.id, key: requirementKey(req.reqSeq), status: req.status };
}

/** The person's reason on each accepted suggestion a decision came from (ISS-281): the triage the
 *  accept wrote carries the agent's note as its own reason, so the accept's is read off the row. */
async function acceptReasonsOf(
  ids: readonly (string | null)[],
): Promise<Map<string, string | null>> {
  const named = [...new Set(ids.filter((id): id is string => id !== null))];
  if (named.length === 0) return new Map();
  const rows = await db
    .select({ id: suggestions.id, reason: suggestions.reason })
    .from(suggestions)
    .where(and(inArray(suggestions.id, named), eq(suggestions.status, 'accepted')));
  return new Map(rows.map((r) => [r.id, r.reason]));
}

type Facts = Parameters<typeof holds>[0];

/** What the viewer may do to the item now, read off their permissions and its phase. */
function canOf(i: {
  facts: Facts;
  row: Row;
  phase: FeedbackPhase;
  userId: string;
  canSeeNotes: boolean;
}): FeedbackView['can'] {
  const { facts, row, phase } = i;
  const approver = holds(facts, 'feedback.approve');
  const untriaged = phase === 'new' || phase === 'reopened';
  return {
    triage: approver && (untriaged || phase === 'triaged'),
    // owner, 2026-10-07: anyone on the project may confirm a fix, not only a BA
    verify: phase === 'resolved',
    reopen: (approver || i.userId === row.reportedBy) && phase === 'resolved',
    askVerify: approver && i.userId !== row.reportedBy && phase === 'resolved',
    redact: holds(facts, 'feedback.redact') && row.redactedAt === null,
    retarget: approver && row.contractVersion === null,
    accept: approver && untriaged,
    snooze: approver && untriaged,
    message: approver,
    note: i.canSeeNotes,
    attach: holds(facts, 'project.write') && row.redactedAt === null,
  };
}

type MessageRow = typeof feedbackMessages.$inferSelect;

function messageViewsOf(
  rows: readonly MessageRow[],
  names: Map<string, string>,
  withhold: boolean,
): FeedbackMessageView[] {
  return rows.map((m) => ({
    id: m.id,
    audience: m.audience,
    text: withhold ? WITHHELD : m.body,
    sentBy: m.sentBy,
    sentByName: names.get(m.sentBy) ?? null,
    sentAgency: m.sentAgency,
    sentAt: m.createdAt.toISOString(),
    recipients: m.recipients.map((id) => ({ id, name: names.get(id) ?? null })),
  }));
}

/** The confirmation of the fix, read off the item's last verified decision: who and when, or Forge's own. */
function verifiedViewOf(
  row: Row,
  decisions: readonly (typeof feedbackDecisions.$inferSelect)[],
  names: Map<string, string>,
  withhold: boolean,
): FeedbackVerifiedView | null {
  if (row.status !== 'verified') return null;
  const d = [...decisions].reverse().find((x) => x.decision === 'verified');
  if (!d) return null;
  return {
    at: d.decidedAt.toISOString(),
    how: d.decidedAgency === 'system' ? 'automatic' : 'person',
    by: d.decidedBy,
    byName: d.decidedBy ? (names.get(d.decidedBy) ?? null) : null,
    byReporter: d.decidedBy === row.reportedBy,
    reason: withhold ? null : d.reason,
  };
}

export async function detailAs(
  viewer: FeedbackActor,
  projectId: string,
  ref: string,
  door: ReadDoor = {},
): Promise<FeedbackView> {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  const row = await rowIn(db, projectId, ref);
  const [
    level,
    access,
    linked,
    decisions,
    attachments,
    questions,
    pointing,
    [open],
    source,
    reporters,
    messages,
    mergedAttachments,
  ] = await Promise.all([
    dataPolicyOf(projectId),
    effectiveProjectRole(viewer.userId, projectId),
    linkedOf(projectId, [row]),
    db
      .select()
      .from(feedbackDecisions)
      .where(eq(feedbackDecisions.feedbackId, row.id))
      .orderBy(asc(feedbackDecisions.decidedAt)),
    db
      .select()
      .from(feedbackAttachments)
      .where(eq(feedbackAttachments.feedbackId, row.id))
      .orderBy(asc(feedbackAttachments.createdAt)),
    db
      .select({
        id: agentQuestions.id,
        status: agentQuestions.status,
        steps: agentQuestions.steps,
      })
      .from(agentQuestions)
      .where(eq(agentQuestions.feedbackId, row.id))
      .orderBy(desc(agentQuestions.createdAt))
      .limit(1),
    duplicateKeysOf(db, row.id),
    db
      .select({ n: count() })
      .from(suggestions)
      .where(and(eq(suggestions.feedbackId, row.id), eq(suggestions.status, 'proposed'))),
    sourceOf(row.id),
    reportersOf(db, row),
    db
      .select()
      .from(feedbackMessages)
      .where(eq(feedbackMessages.feedbackId, row.id))
      .orderBy(asc(feedbackMessages.createdAt)),
    // the evidence of the duplicates merged into this item, read through: each stays on its own record
    db
      .select({ a: feedbackAttachments, seq: feedback.fbSeq })
      .from(feedbackAttachments)
      .innerJoin(feedback, eq(feedback.id, feedbackAttachments.feedbackId))
      .where(eq(feedback.duplicateOf, row.id))
      .orderBy(asc(feedbackAttachments.createdAt)),
  ]);
  const { withhold, shown } = feedbackEgress(level, viewer.agency, door);
  const facts = { projectId, role: access?.role ?? null, grants: access?.grants ?? [] };
  const summary = summaryOf(row, linked, viewer, withhold, viewerCanOf(facts));
  const phase = summary.phase;
  const approver = holds(facts, 'feedback.approve');
  // an internal note is for project members, and not for the reporter it may be about unless they triage
  const canSeeNotes =
    holds(facts, 'project.write') && (approver || !reporters.some((r) => r.id === viewer.userId));
  const shownMessages = messages.filter((m) => m.audience !== 'internal' || canSeeNotes);
  const deciders = await userNames([
    ...decisions.map((d) => d.decidedBy),
    ...reporters.map((r) => r.id),
    ...shownMessages.flatMap((m) => [m.sentBy, ...m.recipients]),
  ]);
  const acceptReasons = await acceptReasonsOf(decisions.map((d) => d.fromSuggestionId));
  const q = questions[0];
  const step = q?.steps.at(-1);
  const root = row.duplicateOf ? linked.roots.get(row.duplicateOf) : undefined;
  return shown<FeedbackView>(
    {
      ...summary,
      verified: verifiedViewOf(row, decisions, deciders, withhold),
      autoVerify: (() => {
        const at = autoVerifyOf(row, phase, linked);
        return at ? { at: at.toISOString(), windowDays: linked.verifyWindowDays } : null;
      })(),
      body: withhold ? null : row.body,
      whereSeen: withhold ? null : row.whereSeen,
      duplicateOf: root ? feedbackKey(root.fbSeq) : null,
      duplicates: pointing,
      source:
        source && withhold ? { agentReport: { ...source.agentReport, targetRef: null } } : source,
      decisions: decisions.map(
        (d): FeedbackDecisionView => ({
          decision: d.decision,
          route: d.route,
          carrier: d.carrier,
          reason: withhold ? null : d.reason,
          decidedBy: d.decidedBy,
          decidedByName: d.decidedBy ? (deciders.get(d.decidedBy) ?? null) : null,
          decidedAgency: d.decidedAgency,
          decidedAt: d.decidedAt.toISOString(),
          fromSuggestionId: d.fromSuggestionId,
          acceptReason:
            withhold || !d.fromSuggestionId
              ? null
              : (acceptReasons.get(d.fromSuggestionId) ?? null),
        }),
      ),
      attachments: [
        ...attachments.map((a) => ({ a, from: null as string | null })),
        ...mergedAttachments.map((m) => ({ a: m.a, from: feedbackKey(m.seq) as string | null })),
      ].map(({ a, from }) => ({
        id: a.id,
        from,
        name: withhold ? 'withheld' : a.name,
        mime: a.mime,
        size: a.size,
        flagged: a.flagged,
        createdAt: a.createdAt.toISOString(),
        url: `/api/projects/${projectId}/feedback/${feedbackKey(row.fbSeq)}/attachments/${a.id}`,
      })),
      reporters: reporters.map((r) => ({
        id: r.id,
        name: deciders.get(r.id) ?? null,
        agency: r.agency,
        from: r.from,
      })),
      messages: messageViewsOf(shownMessages, deciders, withhold),
      clarification: q
        ? {
            id: q.id,
            status: q.status,
            prompt: withhold ? null : (step?.prompt ?? null),
            answer: withhold
              ? null
              : step && 'answerText' in step
                ? (step.answerText ?? null)
                : null,
          }
        : null,
      openSuggestions: open?.n ?? 0,
      shipNotice: await shipNoticeOf(row.id, {
        route: row.route,
        phase: summary.phase,
        reporterAgency: row.reporterAgency,
      }),
      can: canOf({ facts, row, phase, userId: viewer.userId, canSeeNotes }),
      sensitive: level !== 'off',
    },
    feedbackKey(row.fbSeq),
  );
}
