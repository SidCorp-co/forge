/**
 * Feedback writes (workflows `feedback-lifecycle` rev 2 and `feedback-triage` rev 2). Each runs in
 * one transaction under the project's feedback lock and answers an outcome, refusals named and
 * nothing written. Triage, the case and the route write are `triage.ts`, which reaches the decline
 * act here; attachments and the clarification are `attachments.ts`. Every decision is a
 * `feedback_decisions` row.
 */

import {
  type CreateFeedbackRequest,
  type FeedbackRoute,
  type FeedbackTriageEffect,
  type FeedbackView,
  feedbackKey,
} from '@forge/contracts/feedback';
import { FEEDBACK_MACHINE } from '@forge/contracts/feedback-machine';
import { QUESTION_MACHINE } from '@forge/contracts/question-machine';
import type { NodeRef } from '@forge/contracts/workflow-health';
import { and, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { feedback, feedbackDecisions } from '../db/schema-feedback.js';
import { agentQuestions } from '../db/schema-questions.js';
import { lockXact } from '../lib/advisory-lock.js';
import { dataPolicyOf, storedText } from '../lib/data-egress.js';
import { type Refusal, RefusalError } from '../lib/refusal.js';
import { type KernelActor, movedRow, transition } from '../lifecycle/index.js';
import { emitEvent } from '../outbox/index.js';
import { actorFor, permissionFactsOf, projectResource, requireCan } from '../permissions/index.js';
import { designNodesIn, nodeRefRefusal } from '../workflows/index.js';
import { embedFeedbackLater } from './embeddings.js';
import { phaseOfRow } from './list-read.js';
import { detailAs, type FeedbackActor, type Row, rowIn } from './read.js';
import { isRefusal, resolveTarget } from './refs.js';
import {
  decideActRefusal,
  declineRefusal,
  personalActRefusal,
  redactedRefusal,
  reopenRefusal,
  targetCountRefusal,
  verifyAskRefusal,
  verifyRefusal,
} from './rules.js';

export type FeedbackOutcome =
  | { ok: true; feedback: FeedbackView; created?: boolean; effect?: FeedbackTriageEffect }
  | { ok: false; refusals: Refusal[] };

/** The transport a write came through, recorded on an issue a triage files. */
export type FeedbackChannel = 'web' | 'mcp';

export async function inTx(
  body: (tx: Tx) => Promise<Refusal[] | null | undefined>,
): Promise<Refusal[] | null> {
  try {
    return await db.transaction(async (tx) => {
      const refusals = await body(tx);
      if (refusals?.length) throw new RefusalError(refusals, 'FEEDBACK_REFUSED');
      return null;
    });
  } catch (err) {
    if (err instanceof RefusalError) return [...err.refusals];
    throw err;
  }
}

/** Serialises every feedback write of a project, which also orders the FB-n it allocates. */
export async function lockFeedback(tx: Tx, projectId: string): Promise<void> {
  await lockXact(tx, 'feedback', projectId);
}

export async function answer(
  projectId: string,
  id: string,
  viewer: FeedbackActor,
  extra: { created?: boolean; effect?: FeedbackTriageEffect } = {},
): Promise<FeedbackOutcome> {
  return { ok: true, feedback: await detailAs(viewer, projectId, id), ...extra };
}

export const roleFacts = (actor: FeedbackActor, projectId: string) =>
  permissionFactsOf(actor.userId, projectId);

export async function decide(
  tx: Tx,
  row: Row,
  actor: FeedbackActor,
  d: {
    decision: typeof feedbackDecisions.$inferInsert.decision;
    route?: FeedbackRoute | null;
    carrier?: string | null;
    reason?: string | null;
    fromSuggestionId?: string | null;
  },
) {
  const said = d.reason?.trim();
  // A reason is free text a person typed about the item; a sensitive project scrubs it like the body.
  const reason = said ? storedText(await dataPolicyOf(row.projectId), said).text : null;
  await tx.insert(feedbackDecisions).values({
    projectId: row.projectId,
    feedbackId: row.id,
    decision: d.decision,
    route: d.route ?? null,
    carrier: d.carrier ?? null,
    reason,
    decidedBy: actor.userId,
    decidedAgency: actor.agency,
    fromSuggestionId: d.fromSuggestionId ?? null,
  });
}

// a route picked closes the assistant's open clarification (feedback-lifecycle new -> triaged)
export async function closeClarification(tx: Tx, feedbackId: string, why: string) {
  await transition(tx, QUESTION_MACHINE, {
    to: 'void',
    from: 'open',
    set: { voidReason: why, endedBy: 'feedback', endedReason: why, updatedAt: new Date() },
    where: eq(agentQuestions.feedbackId, feedbackId),
    reason: why,
    actor: { type: 'system' },
    source: 'feedback',
    returning: ['id'],
  });
}

type NewFeedback = Omit<typeof feedback.$inferInsert, 'fbSeq'>;

export function feedbackKernelActor(actor: FeedbackActor): KernelActor {
  return { type: 'user', id: actor.userId, agency: actor.agency };
}

export async function insertFeedbackIn(tx: Tx, values: NewFeedback): Promise<string> {
  const [{ next } = { next: 1 }] = await tx
    .select({ next: sql<number>`coalesce(max(${feedback.fbSeq}), 0)::int + 1` })
    .from(feedback)
    .where(eq(feedback.projectId, values.projectId));
  const [row] = await tx
    .insert(feedback)
    .values({ ...values, fbSeq: next })
    .returning({ id: feedback.id, severity: feedback.severity });
  if (!row) throw new Error('feedback: the insert returned no row');
  await emitEvent(tx, 'feedback.filed', {
    projectId: values.projectId,
    feedbackId: row.id,
    severity: row.severity,
  });
  return row.id;
}

/** An endpoint target's three columns, all set or all null (`feedback_endpoint_target_chk`). */
export const endpointColumns = (
  endpoint: { contractSlug: string; contractVersion: string; element: string } | null,
) => ({
  endpointContractSlug: endpoint?.contractSlug ?? null,
  endpointContractVersion: endpoint?.contractVersion ?? null,
  endpointElement: endpoint?.element ?? null,
});

/** A workflow node's columns, checked against that workflow's design; a node without a workflow is refused. */
export async function nodeColumns(
  projectId: string,
  workflowId: string | null,
  node: NodeRef | undefined,
): Promise<{ columns: Partial<NewFeedback> } | { refusal: Refusal }> {
  if (!node) return { columns: {} };
  if (!workflowId) {
    return {
      refusal: {
        code: 'FEEDBACK_NODE_NEEDS_WORKFLOW',
        path: '/node',
        detail:
          'a node names a step or edge of a workflow; send it with a workflow target, or drop it',
      },
    };
  }
  const nodes = await designNodesIn(db, projectId, workflowId);
  const wrong = nodes ? nodeRefRefusal(nodes, node, '/node') : null;
  if (wrong) return { refusal: wrong };
  return {
    columns:
      'step' in node
        ? { stepId: node.step }
        : { edgeFrom: node.edge.from, edgeTo: node.edge.to, edgeLabel: node.edge.label ?? null },
  };
}

export async function preparedFeedback(
  projectId: string,
  actor: FeedbackActor,
  request: CreateFeedbackRequest,
): Promise<{ ok: true; values: NewFeedback } | { ok: false; refusals: Refusal[] }> {
  const count = targetCountRefusal(request, request.whereSeen);
  if (count) return { ok: false, refusals: [count] };
  const target = await resolveTarget(projectId, request, actor.userId);
  if (isRefusal(target)) return { ok: false, refusals: [target] };
  const node = await nodeColumns(projectId, target.workflowId, request.node);
  if ('refusal' in node) return { ok: false, refusals: [node.refusal] };
  const level = await dataPolicyOf(projectId);
  const title = storedText(level, request.title.trim());
  const body = request.body?.trim() ? storedText(level, request.body) : null;
  const seen = target.screen ?? (request.whereSeen?.trim() || null);
  const whereSeen = seen ? storedText(level, seen) : null;
  return {
    ok: true,
    values: {
      projectId,
      kind: request.kind,
      severity: request.severity ?? 'medium',
      title: title.text,
      body: body?.text ?? null,
      whereSeen: whereSeen?.text ?? null,
      requirementId: target.requirementId,
      issueId: target.issueId,
      releaseRunId: target.releaseRunId,
      workflowId: target.workflowId,
      ...endpointColumns(target.endpoint),
      ...node.columns,
      reportedBy: actor.userId,
      reporterAgency: actor.agency,
      scrubbed: title.scrubbed,
      redactions: title.redactions + (body?.redactions ?? 0) + (whereSeen?.redactions ?? 0),
    },
  };
}

export async function createFeedback(input: {
  projectId: string;
  actor: FeedbackActor;
  request: CreateFeedbackRequest;
  /** E3's seam (ISS-61): a filer naming a key gets the one item already filed under it. */
  dedupKey?: string | undefined;
}): Promise<FeedbackOutcome> {
  const { projectId, actor, request } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const prepared = await preparedFeedback(projectId, actor, request);
  if (!prepared.ok) return prepared;
  let id = '';
  let created = true;
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    if (input.dedupKey) {
      const [twin] = await tx
        .select({ id: feedback.id })
        .from(feedback)
        .where(and(eq(feedback.projectId, projectId), eq(feedback.dedupKey, input.dedupKey)));
      if (twin) {
        id = twin.id;
        created = false;
        return null;
      }
    }
    id = await insertFeedbackIn(tx, { ...prepared.values, dedupKey: input.dedupKey ?? null });
    return null;
  });
  if (refusals) return { ok: false, refusals };
  if (created) embedFeedbackLater(id);
  return answer(projectId, id, actor, { created });
}

/** The decline act, reached from triage's decline route: the reason the reporter reads, a decision row. */
export async function declineIn(
  tx: Tx,
  row: Row,
  actor: FeedbackActor,
  reason: string | undefined,
): Promise<Refusal | null> {
  const refused = declineRefusal(row.status, reason);
  if (refused) return refused;
  const moved = await transition(tx, FEEDBACK_MACHINE, {
    to: 'declined',
    expect: row.status,
    set: { updatedAt: new Date() },
    where: eq(feedback.id, row.id),
    reason: reason ?? null,
    actor: feedbackKernelActor(actor),
    source: 'feedback',
    returning: ['id'],
  });
  movedRow(moved);
  await decide(tx, row, actor, { decision: 'declined', reason: reason ?? null });
  await closeClarification(tx, row.id, 'declined');
  return null;
}

async function personalAct(
  input: { projectId: string; ref: string; actor: FeedbackActor; note: string | undefined },
  act: 'verified' | 'reopened',
): Promise<FeedbackOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  const first = await rowIn(db, projectId, input.ref);
  const forbidden = personalActRefusal(
    await roleFacts(actor, projectId),
    act,
    actor.userId === first.reportedBy,
  );
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const row = await rowIn(tx, projectId, first.id, true);
    const phase = await phaseOfRow(projectId, row);
    const refused = act === 'verified' ? verifyRefusal(phase) : reopenRefusal(phase, input.note);
    if (refused) return [refused];
    const moved = await transition(tx, FEEDBACK_MACHINE, {
      to: act,
      expect: row.status,
      set: { updatedAt: new Date() },
      where: eq(feedback.id, row.id),
      reason: input.note?.trim() || null,
      actor: feedbackKernelActor(actor),
      source: 'feedback',
      returning: ['id'],
    });
    movedRow(moved);
    const onBehalf = actor.userId === row.reportedBy ? null : 'on behalf of the reporter';
    await decide(tx, row, actor, {
      decision: act,
      reason:
        [input.note?.trim(), act === 'verified' ? onBehalf : null].filter(Boolean).join(' · ') ||
        null,
    });
    await emitEvent(tx, 'feedback.verifySettled', {
      projectId,
      feedbackId: row.id,
      key: feedbackKey(row.fbSeq),
      decision: act,
    });
    return null;
  });
  if (refusals) return { ok: false, refusals };
  return answer(projectId, first.id, actor);
}

/**
 * feedback-triage `verify-ask`: a holder of feedback.approve sends a resolved item to its reporter,
 * whose bell then holds the ask until the item is verified or reopened.
 */
export async function askReporterToVerify(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
}): Promise<FeedbackOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  const forbidden = decideActRefusal(
    await roleFacts(actor, projectId),
    'asking the reporter to verify',
  );
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const first = await rowIn(db, projectId, input.ref);
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const row = await rowIn(tx, projectId, first.id, true);
    const refused =
      verifyAskRefusal(await phaseOfRow(projectId, row), row.reportedBy === actor.userId) ??
      redactedRefusal(row.redactedAt);
    if (refused) return [refused];
    await emitEvent(tx, 'feedback.verifyAsked', {
      projectId,
      feedbackId: row.id,
      key: feedbackKey(row.fbSeq),
      title: row.title,
      reporter: row.reportedBy,
    });
    return null;
  });
  if (refusals) return { ok: false, refusals };
  return answer(projectId, first.id, actor);
}

/** The reporter confirms the fix, or a holder of feedback.approve on their behalf; never automatic. */
export const verifyFeedback = (input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  note?: string | undefined;
}) => personalAct({ ...input, note: input.note }, 'verified');

/** The reporter says the fix does not answer it, with the reason; it goes back to triage. Anyone else needs feedback.approve. */
export const reopenFeedback = (input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  reason: string | undefined;
}) => personalAct({ ...input, note: input.reason }, 'reopened');
