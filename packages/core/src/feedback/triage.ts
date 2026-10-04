/**
 * Routing a feedback item (workflow `feedback-triage` rev 2): a person picks the route, or accepts
 * an agent's `feedback_triage` suggestion, whose accept calls `triageIn` inside its own
 * transaction. The carrier is linked or filed at draft, a decision row written, and a route onto an
 * issue is a typed record event on that issue.
 */

import type { FeedbackTriage, FeedbackTriageEffect } from '@forge/contracts/feedback';
import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { requirements } from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { announceIssueCreated, insertIssueRow } from '../issues/create-service.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { writeRecordEvent } from '../issues/record-events/store.js';
import { assertProjectAccess } from '../lib/authz.js';
import { dataPolicyOf, egressAt, storedText } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { NamedRefusal } from '../project-config/respond.js';
import { requirementKey } from '../requirements/read.js';
import { linkIssueRefusal } from '../requirements/rules.js';
import { createRequirementIn, lockRequirements } from '../requirements/service.js';
import { type FeedbackActor, feedbackKey, phaseOfRow, type Row, rowIn } from './read.js';
import { isRefusal, issueRefIn, requirementRefIn, targetTypeOf } from './refs.js';
import {
  decideActRefusal,
  duplicateRefusal,
  type RouteFacts,
  routeFitRefusal,
  routeShapeRefusal,
  triagePhaseRefusal,
} from './rules.js';
import {
  answer,
  closeClarification,
  decide,
  type FeedbackChannel,
  type FeedbackOutcome,
  inTx,
  lockFeedback,
  roleFacts,
} from './service.js';

/** What a triage filed that its caller announces once the transaction committed. */
export interface TriageWritten {
  refusals: NamedRefusal[] | null;
  effect?: FeedbackTriageEffect;
  createdIssueId?: string;
}

async function fileDraftIssue(
  tx: Tx,
  row: Row,
  t: FeedbackTriage,
  actor: FeedbackActor,
  channel: FeedbackChannel,
  fromSuggestionId: string | null,
): Promise<string> {
  const key = feedbackKey(row.fbSeq);
  // cm:guard an issue is product content every agent reads, so the reporter's operational text is
  // copied into it only as the one egress rule lets feedback leave (surface `feedback`): at
  // no_egress the issue carries the reference only, in its title and its body alike
  const copied = egressAt(
    await dataPolicyOf(row.projectId),
    'feedback',
    { title: row.title, body: row.body ?? '' },
    key,
  );
  const carried = copied.ok
    ? [`Carries ${key}: ${copied.value.title}`, copied.value.body].filter(Boolean).join('\n\n')
    : `Carries ${key}. Its content stays in Forge under this project's no_egress policy; read it on the Feedback page.`;
  let requirementId: string | null = null;
  if (row.requirementId) {
    const [req] = await tx
      .select({ status: requirements.status })
      .from(requirements)
      .where(eq(requirements.id, row.requirementId));
    if (req && !linkIssueRefusal(req.status)) requirementId = row.requirementId;
  }
  const issue = await insertIssueRow(tx, {
    projectId: row.projectId,
    title: t.createIssue?.title ?? (copied.ok ? copied.value.title : `Feedback ${key}`),
    description: t.createIssue?.description ?? carried,
    descriptionFormat: 'markdown',
    status: 'draft',
    priority: t.severity ?? row.severity,
    category: (t.kind ?? row.kind) === 'bug' ? 'bug' : 'feature',
    createdById: actor.userId,
    createdByDeviceId: null,
    createdVia: channel,
    requirementId,
    fromSuggestionId,
  });
  return issue.id;
}

/**
 * Writes a route inside the caller's transaction, which holds the project's feedback lock: the
 * carrier is resolved or filed, the route checked against the item, the head moved to triaged and
 * a decision row written. Refusals roll the caller back.
 */
export async function triageIn(
  tx: Tx,
  input: {
    projectId: string;
    row: Row;
    triage: FeedbackTriage;
    actor: FeedbackActor;
    channel: FeedbackChannel;
    fromSuggestionId?: string | null;
  },
): Promise<TriageWritten> {
  const { projectId, row, triage: t, actor } = input;
  const phase = await phaseOfRow(projectId, row);
  const early = triagePhaseRefusal(phase) ?? routeShapeRefusal(t);
  if (early) return { refusals: [early] };
  const set: Partial<typeof feedback.$inferInsert> = {
    route: t.route,
    routedIssueId: null,
    routedRequirementId: null,
    routedSuggestionId: null,
    duplicateOf: null,
    answer: null,
  };
  let carrier: string | null = null;
  let suggestionFacts: RouteFacts['suggestion'] = null;
  let routedRequirement: { key: string; status: string } | null = null;
  let createdIssueId: string | undefined;
  if (t.route === 'issue' && t.issue) {
    const issue = await issueRefIn(projectId, t.issue, actor.userId, '/issue');
    if (isRefusal(issue)) return { refusals: [issue] };
    set.routedIssueId = issue.id;
    carrier = issue.key;
  }
  if (t.route === 'revision' && t.suggestion) {
    const [s] = await tx
      .select({
        id: suggestions.id,
        kind: suggestions.kind,
        requirementId: suggestions.requirementId,
      })
      .from(suggestions)
      .where(and(eq(suggestions.id, t.suggestion), eq(suggestions.projectId, projectId)));
    if (!s) {
      return {
        refusals: [
          {
            code: 'FEEDBACK_TARGET_UNKNOWN',
            path: '/suggestion',
            detail: `project ${projectId} holds no suggestion ${t.suggestion}.`,
          },
        ],
      };
    }
    suggestionFacts = { kind: s.kind, requirementId: s.requirementId };
    set.routedSuggestionId = s.id;
    carrier = s.id;
  }
  if (t.route === 'new_requirement' && t.requirement) {
    const req = await requirementRefIn(projectId, t.requirement, '/requirement');
    if (isRefusal(req)) return { refusals: [req] };
    routedRequirement = { key: req.key, status: req.status };
    set.routedRequirementId = req.id;
    carrier = req.key;
  }
  if (t.route === 'answer') {
    const said = t.answer?.trim();
    set.answer = said ? storedText(await dataPolicyOf(projectId), said).text : null;
  }
  if (t.route === 'duplicate' && t.duplicateOf) {
    const root = await rowIn(tx, projectId, t.duplicateOf);
    const rootOf = root.duplicateOf ? await rowIn(tx, projectId, root.duplicateOf) : null;
    const pointing = await tx
      .select({ seq: feedback.fbSeq })
      .from(feedback)
      .where(eq(feedback.duplicateOf, row.id));
    const chain = duplicateRefusal(
      row.id,
      {
        id: root.id,
        key: feedbackKey(root.fbSeq),
        duplicateOfKey: rootOf ? feedbackKey(rootOf.fbSeq) : null,
      },
      pointing.map((p) => feedbackKey(p.seq)),
    );
    if (chain) return { refusals: [chain] };
    set.duplicateOf = root.id;
    carrier = feedbackKey(root.fbSeq);
  }
  const fit = routeFitRefusal(t, {
    kind: t.kind ?? row.kind,
    targetType: targetTypeOf(row),
    targetRequirementId: row.requirementId,
    suggestion: suggestionFacts,
    routedRequirement,
  });
  if (fit) return { refusals: [fit] };
  if (t.route === 'issue' && t.createIssue) {
    createdIssueId = await fileDraftIssue(
      tx,
      row,
      t,
      actor,
      input.channel,
      input.fromSuggestionId ?? null,
    );
    set.routedIssueId = createdIssueId;
    const [n] = await tx
      .select({ seq: issues.issSeq })
      .from(issues)
      .where(eq(issues.id, createdIssueId));
    carrier = n ? formatIssueRef(await activeIssuePrefix(projectId), n.seq) : createdIssueId;
  }
  if (t.route === 'new_requirement' && t.title) {
    await lockRequirements(tx, projectId);
    const created = await createRequirementIn(tx, {
      projectId,
      actor,
      title: t.title,
      write: { reason: `Started from ${feedbackKey(row.fbSeq)}`, criteria: [] },
    });
    if (created.refusals?.length) return { refusals: created.refusals };
    const [req] = await tx
      .select({ seq: requirements.reqSeq })
      .from(requirements)
      .where(eq(requirements.id, created.id));
    set.routedRequirementId = created.id;
    carrier = req ? requirementKey(req.seq) : created.id;
  }
  await tx
    .update(feedback)
    .set({
      ...set,
      status: 'triaged',
      ...(t.kind ? { kind: t.kind } : {}),
      ...(t.severity ? { severity: t.severity } : {}),
      updatedAt: new Date(),
    })
    .where(eq(feedback.id, row.id));
  await decide(tx, row, actor, {
    decision: 'triaged',
    route: t.route,
    carrier,
    reason: t.note ?? null,
    fromSuggestionId: input.fromSuggestionId ?? null,
  });
  await closeClarification(tx, row.id, `routed as ${t.route}`);
  if (set.routedIssueId) {
    await writeRecordEvent(
      {
        issueId: set.routedIssueId,
        actor: { type: 'user', id: actor.userId, agency: actor.agency },
        kind: 'decision',
        contract: 1,
        fields: [
          { key: 'lead', value: `${feedbackKey(row.fbSeq)} routed to this issue` },
          { key: 'feedback', value: feedbackKey(row.fbSeq) },
          { key: 'outcome', value: createdIssueId ? 'filed' : 'linked' },
        ],
      },
      tx,
    );
  }
  return {
    refusals: null,
    effect: { feedback: feedbackKey(row.fbSeq), route: t.route, carrier },
    ...(createdIssueId ? { createdIssueId } : {}),
  };
}

/** After the transaction that filed a draft issue committed: the hook every issue create emits. */
export async function announceTriage(written: TriageWritten, actor: FeedbackActor) {
  if (!written.createdIssueId) return;
  const [issue] = await db.select().from(issues).where(eq(issues.id, written.createdIssueId));
  if (!issue) return;
  await announceIssueCreated(issue, { type: 'user', id: actor.userId, agency: actor.agency });
}

/** A holder of feedback.approve picks the route, an agent included (ADR 0007). */
export async function triageFeedback(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  triage: FeedbackTriage;
  channel: FeedbackChannel;
}): Promise<FeedbackOutcome> {
  const { projectId, actor } = input;
  await assertProjectAccess(projectId, actor.userId, 'viewer');
  const forbidden = decideActRefusal(
    await roleFacts(actor, projectId),
    projectId,
    'picking a feedback route',
  );
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const first = await rowIn(db, projectId, input.ref);
  let written: TriageWritten = { refusals: null };
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const row = await rowIn(tx, projectId, first.id, true);
    written = await triageIn(tx, {
      projectId,
      row,
      triage: input.triage,
      actor,
      channel: input.channel,
    });
    return written.refusals;
  });
  if (refusals) return { ok: false, refusals };
  await announceTriage(written, actor);
  return answer(projectId, first.id, actor, written.effect ? { effect: written.effect } : {});
}
