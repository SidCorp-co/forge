import {
  type FeedbackDecisionView,
  type FeedbackView,
  feedbackKey,
} from '@forge/contracts/feedback';
import type { ActorAgency } from '@forge/contracts/permissions';
import { requirementKey } from '@forge/contracts/requirements';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import { feedback, feedbackAttachments, feedbackDecisions } from '../db/schema-feedback.js';
import { agentQuestions } from '../db/schema-questions.js';
import { suggestions } from '../db/schema-suggestions.js';
import { findIssueById, isUuid } from '../issues/index.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { userNames } from '../lib/people.js';
import { actorFor, holds, projectResource, requireCan } from '../permissions/index.js';
import { rowIn as requirementRowIn } from '../requirements/index.js';
import { feedbackEgress, type ReadDoor } from './egress.js';
import { linkedOf, summaryOf } from './list-read.js';
import { sourceOf } from './relations.js';

export interface FeedbackActor {
  userId: string;
  agency: ActorAgency;
}

export type Row = typeof feedback.$inferSelect;

export const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

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

export async function detailAs(
  viewer: FeedbackActor,
  projectId: string,
  ref: string,
  door: ReadDoor = {},
): Promise<FeedbackView> {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  const row = await rowIn(db, projectId, ref);
  const [level, access, linked, decisions, attachments, questions, pointing, [open], source] =
    await Promise.all([
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
    ]);
  const { withhold, shown } = feedbackEgress(level, viewer.agency, door);
  const summary = summaryOf(row, linked, viewer, withhold);
  const deciders = await userNames(decisions.map((d) => d.decidedBy));
  const facts = { projectId, role: access?.role ?? null, grants: access?.grants ?? [] };
  const q = questions[0];
  const step = q?.steps.at(-1);
  const root = row.duplicateOf ? linked.roots.get(row.duplicateOf) : undefined;
  return shown<FeedbackView>(
    {
      ...summary,
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
          decidedByName: deciders.get(d.decidedBy) ?? null,
          decidedAgency: d.decidedAgency,
          decidedAt: d.decidedAt.toISOString(),
          fromSuggestionId: d.fromSuggestionId,
        }),
      ),
      attachments: attachments.map((a) => ({
        id: a.id,
        name: withhold ? 'withheld' : a.name,
        mime: a.mime,
        size: a.size,
        flagged: a.flagged,
        createdAt: a.createdAt.toISOString(),
      })),
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
      can: {
        triage:
          holds(facts, 'feedback.approve') &&
          ['new', 'triaged', 'reopened'].includes(summary.phase),
        verify: holds(facts, 'feedback.approve') && summary.phase === 'resolved',
        reopen:
          (holds(facts, 'feedback.approve') || viewer.userId === row.reportedBy) &&
          summary.phase === 'resolved',
        redact: holds(facts, 'feedback.redact') && row.redactedAt === null,
      },
      sensitive: level !== 'off',
    },
    feedbackKey(row.fbSeq),
  );
}
