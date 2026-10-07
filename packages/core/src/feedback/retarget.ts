/**
 * Retarget (ISS-264): a holder of feedback.approve corrects what an item is about, at any phase.
 * The new target is named and refused exactly as at create (`targetCountRefusal`, `resolveTarget`),
 * the item's status, route and phase are left alone, and the move is a `retargeted` decision row
 * naming the target it replaced. A requirement then lists the item through `feedbackLinksOf`, which
 * reads the target columns live.
 */

import type { FeedbackRetargetRequest, FeedbackTargetView } from '@forge/contracts/feedback';
import { feedbackKey } from '@forge/contracts/feedback';
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { suggestions } from '../db/schema-suggestions.js';
import { dataPolicyOf, storedText } from '../lib/data-egress.js';
import type { Refusal } from '../lib/refusal.js';
import { linkedOf } from './list-read.js';
import { type FeedbackActor, type Row, targetRequirementOf } from './read.js';
import { isRefusal, resolveTarget } from './refs.js';
import { retargetRefusal, targetCountRefusal } from './rules.js';
import { decide, endpointColumns, type FeedbackOutcome, nodeColumns } from './service.js';
import { targetView } from './target-view.js';
import { approvedActOn } from './triage.js';

const ARC_CLEARED = {
  requirementId: null,
  issueId: null,
  releaseRunId: null,
  workflowId: null,
  endpointContractSlug: null,
  endpointContractVersion: null,
  endpointElement: null,
  stepId: null,
  edgeFrom: null,
  edgeTo: null,
  edgeLabel: null,
} as const;

function nodeText(v: FeedbackTargetView): string | null {
  if (!v.node) return null;
  if ('step' in v.node) return `step ${v.node.step}`;
  const e = v.node.edge;
  return `edge ${e.from} → ${e.to}${e.label ? ` (${e.label})` : ''}`;
}

const facts = (v: FeedbackTargetView) => ({ type: v.type, key: v.key, node: nodeText(v) });

function said(v: ReturnType<typeof facts>): string {
  const what = v.type === 'screen' ? `screen “${v.key}”` : `${v.type} ${v.key}`;
  return v.node ? `${what}, ${v.node}` : what;
}

/** The requirement a revision route's suggestion revises, by key, where the item is routed so. */
async function revisionFacts(tx: Tx, row: Row, next: Row) {
  if (row.route !== 'revision' || !row.routedSuggestionId) return null;
  const [s] = await tx
    .select({ requirementId: suggestions.requirementId })
    .from(suggestions)
    .where(eq(suggestions.id, row.routedSuggestionId));
  const revised = s?.requirementId
    ? await targetRequirementOf(tx, { ...row, ...ARC_CLEARED, requirementId: s.requirementId })
    : null;
  const nextRequirement = await targetRequirementOf(tx, next);
  return { revises: revised?.key ?? null, nextRequirement: nextRequirement?.key ?? null };
}

export async function retargetIn(
  tx: Tx,
  row: Row,
  actor: FeedbackActor,
  request: FeedbackRetargetRequest,
): Promise<Refusal[] | null> {
  const count = targetCountRefusal(request, undefined);
  if (count) return [count];
  const target = await resolveTarget(row.projectId, request, actor.userId);
  if (isRefusal(target)) return [target];
  const node = await nodeColumns(row.projectId, target.workflowId, request.node);
  if ('refusal' in node) return [node.refusal];
  const level = await dataPolicyOf(row.projectId);
  const columns = {
    ...ARC_CLEARED,
    requirementId: target.requirementId,
    issueId: target.issueId,
    releaseRunId: target.releaseRunId,
    workflowId: target.workflowId,
    ...endpointColumns(target.endpoint),
    stepId: node.columns.stepId ?? null,
    edgeFrom: node.columns.edgeFrom ?? null,
    edgeTo: node.columns.edgeTo ?? null,
    edgeLabel: node.columns.edgeLabel ?? null,
    whereSeen:
      target.type === 'screen' ? storedText(level, target.screen ?? '').text : row.whereSeen,
  };
  const next: Row = { ...row, ...columns };
  const linked = await linkedOf(row.projectId, [row, next]);
  const current = facts(targetView(row, linked));
  const moved = facts(targetView(next, linked));
  const contract = row.contractVersion ? targetView(row, linked).key : null;
  const refused = retargetRefusal({
    key: feedbackKey(row.fbSeq),
    current,
    next: moved,
    contract,
    redacted: row.redactedAt !== null,
    revision: contract ? null : await revisionFacts(tx, row, next),
  });
  if (refused) return [refused];
  await tx
    .update(feedback)
    .set({ ...columns, updatedAt: new Date() })
    .where(eq(feedback.id, row.id));
  const note = request.reason?.trim();
  await decide(tx, row, actor, {
    decision: 'retargeted',
    carrier: moved.type === 'screen' ? null : moved.key,
    reason: [`from ${said(current)} to ${said(moved)}`, note].filter(Boolean).join(' · '),
  });
  return null;
}

/** `POST …/feedback/:fb/retarget`: a holder of feedback.approve corrects what the item is about. */
export function retargetFeedback(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  request: FeedbackRetargetRequest;
}): Promise<FeedbackOutcome> {
  return approvedActOn(input, 'changing what feedback is about', async (tx, row) => ({
    refusals: await retargetIn(tx, row, input.actor, input.request),
  }));
}
