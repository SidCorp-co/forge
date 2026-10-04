import {
  type FeedbackDecisionView,
  type FeedbackSummary,
  type FeedbackView,
  feedbackKey,
} from '@forge/contracts/feedback';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedbackAttachments, feedbackDecisions } from '../db/schema-feedback.js';
import { agentQuestions } from '../db/schema-questions.js';
import { suggestions } from '../db/schema-suggestions.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { userNames } from '../lib/people.js';
import { actorFor, holds, projectResource, requireCan } from '../permissions/index.js';
import { feedbackEgress, type ReadDoor } from './egress.js';
import { duplicateKeysOf, type FeedbackActor, type Row, rowIn } from './read.js';
import { sourceOf } from './relations.js';
import { linkedOf, summaryOf } from './summary.js';

function detailRowsOf(feedbackId: string) {
  return Promise.all([
    db
      .select()
      .from(feedbackDecisions)
      .where(eq(feedbackDecisions.feedbackId, feedbackId))
      .orderBy(asc(feedbackDecisions.decidedAt)),
    db
      .select()
      .from(feedbackAttachments)
      .where(eq(feedbackAttachments.feedbackId, feedbackId))
      .orderBy(asc(feedbackAttachments.createdAt)),
    db
      .select({ id: agentQuestions.id, status: agentQuestions.status, steps: agentQuestions.steps })
      .from(agentQuestions)
      .where(eq(agentQuestions.feedbackId, feedbackId))
      .orderBy(desc(agentQuestions.createdAt))
      .limit(1),
    duplicateKeysOf(db, feedbackId),
    db
      .select({ n: count() })
      .from(suggestions)
      .where(and(eq(suggestions.feedbackId, feedbackId), eq(suggestions.status, 'proposed'))),
    sourceOf(feedbackId),
  ]);
}

type Question = Awaited<ReturnType<typeof detailRowsOf>>[2][number];

function clarificationOf(
  q: Question | undefined,
  withhold: boolean,
): FeedbackView['clarification'] {
  if (!q) return null;
  const step = q.steps.at(-1);
  return {
    id: q.id,
    status: q.status,
    prompt: withhold ? null : (step?.prompt ?? null),
    answer: withhold || !step || !('answerText' in step) ? null : (step.answerText ?? null),
  };
}

function canOf(
  facts: Parameters<typeof holds>[0],
  summary: FeedbackSummary,
  row: Row,
): FeedbackView['can'] {
  const approves = holds(facts, 'feedback.approve');
  return {
    triage: approves && ['new', 'triaged', 'reopened'].includes(summary.phase),
    route:
      summary.phase === 'triaged' &&
      summary.case !== null &&
      summary.case.routedAt === null &&
      approves,
    verify: approves && summary.phase === 'resolved',
    redact: holds(facts, 'feedback.redact') && row.redactedAt === null,
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
  const [level, access, linked, [decisions, attachments, questions, pointing, [open], source]] =
    await Promise.all([
      dataPolicyOf(projectId),
      effectiveProjectRole(viewer.userId, projectId),
      linkedOf(projectId, [row]),
      detailRowsOf(row.id),
    ]);
  const { withhold, shown } = feedbackEgress(level, viewer.agency, door);
  const summary = summaryOf(row, linked, viewer, withhold);
  const deciders = await userNames(decisions.map((d) => d.decidedBy));
  const facts = { projectId, role: access?.role ?? null, grants: access?.grants ?? [] };
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
      clarification: clarificationOf(questions[0], withhold),
      openSuggestions: open?.n ?? 0,
      can: canOf(facts, summary, row),
      sensitive: level !== 'off',
    },
    feedbackKey(row.fbSeq),
  );
}
