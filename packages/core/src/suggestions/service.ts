/**
 * Suggestions (workflow `suggestion-lifecycle` rev 5): what the BA assistant, a master or a member
 * writes instead of changing anything. A holder of suggestions.approve accepts or rejects; the accept writes the
 * effect in the same transaction, compare-and-set on the target head, and the effect points back
 * (requirement_revisions.from_suggestion_id). A suggestion never makes anything current: a revision
 * it carries lands as a draft. Proposing and revising are `propose.ts`, the guards `rules.ts`, the
 * reads `read.ts`; each write runs in one transaction and answers an outcome, refusals named and
 * nothing written.
 */

import { SUGGESTION_MACHINE } from '@forge/contracts/suggestion-machine';
import { SUGGESTION_PAYLOADS } from '@forge/contracts/suggestions';
import { and, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import { suggestions } from '../db/schema-suggestions.js';
import {
  activeIssuePrefix,
  resolveIssueRouteRef,
  transitionIssueStatus,
  writeIssueRelations,
} from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { RefusalError, refusalEnvelope } from '../lib/refusal.js';
import { type KernelActor, movedRow, transition } from '../lifecycle/index.js';
import {
  actorFor,
  permissionRefusalFor,
  projectResource,
  requireCan,
} from '../permissions/index.js';
import { lockRequirements } from '../requirements/index.js';
import { type AcceptChannel, type Effect, type EffectWritten, writeEffect } from './effects.js';
import { reviseSuggestion as reviseProposed } from './propose.js';
import {
  headOf,
  type Row,
  rowOf,
  type SuggestionActor,
  suggestionKernelActor,
  targetOfRow,
} from './read.js';
import { decidedRefusal, rejectReasonRefusal, withdrawRefusal } from './rules.js';
import { markMovedStale } from './stale.js';
import {
  answer,
  inTx,
  lockTarget,
  movedBase,
  recordDecision,
  type SuggestionOutcome,
} from './write.js';

export { createSuggestion } from './propose.js';

/**
 * A reviewer's edit of a feedback triage, accepted in the same request when the reviewer may route
 * the feedback: the reviser already holds suggestions.approve (revising rejects the original), so a
 * second call to accept their own edit cost one more act and left the feedback reading `proposed`
 * between them (HOP run 2026-10-05, FB-2). Any other kind, or a reviewer without feedback.approve,
 * leaves the revision proposed as the suggestion lifecycle draws it.
 */
export async function reviseSuggestion(
  input: Parameters<typeof reviseProposed>[0],
): Promise<SuggestionOutcome> {
  const revised = await reviseProposed(input);
  if (!revised.ok || revised.suggestion.kind !== 'feedback_triage') return revised;
  const mayRoute = await permissionRefusalFor(
    actorFor(input.actor.userId, input.actor.agency),
    'feedback.approve',
    projectResource(input.projectId),
    'routing a feedback item',
  );
  if (mayRoute) return revised;
  const accepted = await acceptSuggestion({
    projectId: input.projectId,
    id: revised.suggestion.id,
    actor: input.actor,
    reason: `accepted by its reviewer in the revise that wrote it (revises ${input.id})${
      input.reason?.trim() ? `: ${input.reason.trim()}` : ''
    }`,
  });
  if (accepted.ok) return { ...accepted, created: true };
  // The revise committed, so the answer is the revision as it stands (proposed), never a refusal
  // that would read as though nothing was written; the refused accept is named beside it.
  return {
    ...revised,
    acceptRefused: refusalEnvelope(accepted.refusals, 'SUGGESTION_REFUSED').error,
  };
}
export type { SuggestionOutcome } from './write.js';

// Workflow issue-lifecycle step `dropped` ("not work: … a duplicate"): accepting a duplicate
// on an issue drops it with the root named and a relates edge to it, through the one transition
// writer; the accept is written inside that transition's transaction, so neither lands alone
async function acceptDuplicateOfIssue(
  projectId: string,
  first: Row,
  actor: SuggestionActor,
  reason: string | null,
): Promise<SuggestionOutcome> {
  const target = targetOfRow(first);
  const p = SUGGESTION_PAYLOADS.duplicate.schema.parse(first.payload);
  const prefix = await activeIssuePrefix(projectId);
  const [issue] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
      seq: issues.issSeq,
    })
    .from(issues)
    .where(eq(issues.id, target.id));
  if (!issue) throw new Error(`suggestions: issue ${target.id} vanished under its suggestion`);
  const key = formatIssueRef(prefix, issue.seq);
  const root = await resolveIssueRouteRef(p.duplicateOf, projectId, actor.userId).catch((err) => {
    if (err instanceof HTTPException) return null;
    throw err;
  });
  if (!root || root.projectId !== projectId || root.id === issue.id) {
    return {
      ok: false,
      refusals: [
        {
          code: 'SUGGESTION_PAYLOAD_INVALID',
          path: '/payload/duplicateOf',
          detail:
            !root || root.projectId !== projectId
              ? `${p.duplicateOf} is not an issue of this project, so ${key} cannot be marked its duplicate.`
              : `${key} cannot be a duplicate of itself.`,
        },
      ],
    };
  }
  const rootKey = formatIssueRef(prefix, root.issSeq);
  try {
    await transitionIssueStatus(
      {
        id: issue.id,
        projectId,
        status: issue.status as IssueStatus,
        reopenCount: issue.reopenCount,
      },
      'dropped',
      { type: 'user', id: actor.userId, agency: actor.agency },
      {
        transitionReason: `Duplicate of ${rootKey}${p.note ? `: ${p.note}` : ''} (suggestion ${first.id}).`,
        beforeStatusWrite: async (tx) => {
          await lockTarget(tx, projectId, target);
          const row = await rowOf(tx, projectId, first.id, true);
          const decided = decidedRefusal(row.status);
          if (decided) throw new RefusalError([decided], 'SUGGESTION_REFUSED');
          await writeIssueRelations(
            {
              actor: { type: 'user', id: actor.userId, agency: actor.agency },
              createdById: actor.userId,
            },
            projectId,
            issue.id,
            [{ kind: 'relates', dependsOnId: root.id, reason: `duplicate of ${rootKey}` }],
            tx,
          );
          const decidedAccepted = await transition(tx, SUGGESTION_MACHINE, {
            to: 'accepted',
            expect: 'proposed',
            set: { decidedBy: actor.userId, decidedAt: new Date(), reason },
            where: eq(suggestions.id, row.id),
            reason: reason,
            actor: suggestionKernelActor(actor),
            source: 'suggestions',
            returning: ['id'],
          });
          movedRow(decidedAccepted);
          await recordDecision(tx, row, actor, 'accepted', reason);
        },
      },
    );
  } catch (err) {
    if (err instanceof RefusalError) return { ok: false, refusals: [...err.refusals] };
    throw err;
  }
  return answer(first.id, {
    effect: { issueId: issue.id, issue: key, duplicateOf: rootKey, status: 'dropped' },
  });
}

/**
 * A person accepts: the effect is written in the same transaction, compare-and-set on the head. A
 * moved head refuses SUGGESTION_BASE_STALE naming both revisions and marks the row stale, which is
 * the truth about it whatever the caller does next; a row the move already marked stale answers
 * the same refusal, not a bare SUGGESTION_DECIDED.
 */
export async function acceptSuggestion(input: {
  projectId: string;
  id: string;
  actor: SuggestionActor;
  channel?: AcceptChannel | undefined;
  /** The person's reason, and the authority it is accepted under; kept on the row (ISS-84). */
  reason?: string | null | undefined;
}): Promise<SuggestionOutcome> {
  const { projectId, actor } = input;
  const reason = input.reason?.trim() || null;
  const first = await rowOf(db, projectId, input.id);
  const forbidden = await permissionRefusalFor(
    actorFor(actor.userId, actor.agency),
    'suggestions.approve',
    projectResource(projectId),
    'accepting a suggestion',
  );
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const target = targetOfRow(first);
  if (first.kind === 'duplicate' && target.type === 'issue' && first.status === 'proposed') {
    return acceptDuplicateOfIssue(projectId, first, actor, reason);
  }
  let written: EffectWritten = { refusals: null };
  const stale: { reason: string | null } = { reason: null };
  const refusals = await inTx(async (tx) => {
    await lockTarget(tx, projectId, target);
    if (first.kind === 'requirement_draft') await lockRequirements(tx, projectId);
    const row = await rowOf(tx, projectId, input.id, true);
    const head = await headOf(tx, projectId, target);
    const moved = movedBase(row, target, head);
    if (row.status === 'stale' && moved) return [moved];
    const decided = decidedRefusal(row.status);
    if (decided) return [decided];
    if (moved) {
      stale.reason = moved.detail;
      return [moved];
    }
    written = await writeEffect(tx, projectId, row, head, actor, input.channel ?? 'web');
    if (written.refusals) return written.refusals;
    const decidedAccepted = await transition(tx, SUGGESTION_MACHINE, {
      to: 'accepted',
      expect: 'proposed',
      set: { decidedBy: actor.userId, decidedAt: new Date(), reason },
      where: eq(suggestions.id, row.id),
      reason: reason,
      actor: suggestionKernelActor(actor),
      source: 'suggestions',
      returning: ['id'],
    });
    movedRow(decidedAccepted);
    await recordDecision(tx, row, actor, 'accepted', reason);
    return null;
  });
  if (stale.reason) await markMovedStale(first.id, stale.reason, suggestionKernelActor(actor));
  if (refusals) return { ok: false, refusals };
  const effect: Effect | undefined = written.effect;
  return answer(first.id, effect ? { effect } : {});
}

export async function rejectSuggestion(input: {
  projectId: string;
  id: string;
  actor: SuggestionActor;
  reason: string | null | undefined;
}): Promise<SuggestionOutcome> {
  const { projectId, actor } = input;
  const forbidden = await permissionRefusalFor(
    actorFor(actor.userId, actor.agency),
    'suggestions.approve',
    projectResource(projectId),
    'rejecting a suggestion',
  );
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const early = rejectReasonRefusal(input.reason);
  if (early) return { ok: false, refusals: [early] };
  const reason = input.reason?.trim() ?? null;
  const refusals = await inTx(async (tx) => {
    const row = await rowOf(tx, projectId, input.id, true);
    const decided = decidedRefusal(row.status);
    if (decided) return [decided];
    const decidedRejected = await transition(tx, SUGGESTION_MACHINE, {
      to: 'rejected',
      expect: 'proposed',
      set: { decidedBy: actor.userId, decidedAt: new Date(), reason },
      where: eq(suggestions.id, row.id),
      reason: reason,
      actor: suggestionKernelActor(actor),
      source: 'suggestions',
      returning: ['id'],
    });
    movedRow(decidedRejected);
    await recordDecision(tx, row, actor, 'rejected', reason);
    return null;
  });
  if (refusals) return { ok: false, refusals };
  return answer(input.id);
}

export async function withdrawSuggestion(input: {
  projectId: string;
  id: string;
  actor: SuggestionActor;
}): Promise<SuggestionOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const refusals = await inTx(async (tx) => {
    const row = await rowOf(tx, projectId, input.id, true);
    const refusal = withdrawRefusal(actor.userId, row.producerId) ?? decidedRefusal(row.status);
    if (refusal) return [refusal];
    const decidedWithdrawn = await transition(tx, SUGGESTION_MACHINE, {
      to: 'withdrawn',
      expect: 'proposed',
      set: { decidedAt: new Date(), reason: 'withdrawn by its producer' },
      where: eq(suggestions.id, row.id),
      reason: 'withdrawn by its producer',
      actor: suggestionKernelActor(actor),
      source: 'suggestions',
      returning: ['id'],
    });
    movedRow(decidedWithdrawn);
    await recordDecision(tx, row, actor, 'withdrawn');
    return null;
  });
  if (refusals) return { ok: false, refusals };
  return answer(input.id);
}

/**
 * A feedback's reporter data is deleted (UC15): its proposed suggestions are withdrawn, a decided
 * one's payload is purged, and an accepted one keeps only that it was redacted.
 */
export async function redactFeedbackSuggestions(
  tx: Tx,
  feedbackId: string,
  args: { why: string; now: Date; actor: KernelActor },
): Promise<void> {
  await transition(tx, SUGGESTION_MACHINE, {
    to: 'withdrawn',
    from: 'proposed',
    set: { decidedAt: args.now, reason: args.why },
    where: eq(suggestions.feedbackId, feedbackId),
    reason: args.why,
    actor: args.actor,
    source: 'feedback-redact',
    returning: ['id'],
  });
  await tx
    .update(suggestions)
    .set({ payload: null, payloadPurgedAt: args.now })
    .where(
      and(
        eq(suggestions.feedbackId, feedbackId),
        inArray(suggestions.status, ['rejected', 'stale', 'withdrawn']),
      ),
    );
  await tx
    .update(suggestions)
    .set({ payload: { redacted: true } })
    .where(and(eq(suggestions.feedbackId, feedbackId), eq(suggestions.status, 'accepted')));
}
