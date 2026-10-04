/**
 * Suggestions (workflow `suggestion-lifecycle` rev 2): what the BA assistant, or an agent proposing a
 * breakdown, writes instead of changing anything. A person accepts or rejects; the accept writes the
 * effect in the same transaction, compare-and-set on the target head, and the effect points back
 * (requirement_revisions.from_suggestion_id). A suggestion never makes anything current: a revision
 * it carries lands as a draft. Proposing and revising are `propose.ts`, the guards `rules.ts`, the
 * reads `read.ts`; each write runs in one transaction and answers an outcome, refusals named and
 * nothing written.
 */

import { SUGGESTION_PAYLOADS } from '@forge/contracts/suggestions';
import { SUGGESTION_MACHINE } from '@forge/contracts/suggestion-machine';
import { and, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import { suggestions } from '../db/schema-suggestions.js';
import { announceTriage } from '../feedback/triage.js';
import { TransitionError, transitionIssueStatus } from '../issues/apply-transition.js';
import { announceIssueCreated } from '../issues/create-service.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { resolveIssueRouteRef } from '../issues/issue-route-ref.js';
import {
  flushIssueRelationEffects,
  type PendingIssueRelation,
  writeIssueRelations,
} from '../issues/relations-service.js';
import { emitIssueFieldUpdate } from '../issues/update-hook.js';
import { permissionRefusalFor, requireCan } from '../permissions/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type KernelActor, notAnEdgeError, transition } from '../lifecycle/transition.js';
import { hooks } from '../pipeline/hooks.js';
import { lockRequirements } from '../requirements/service.js';
import { type AcceptChannel, type Effect, type EffectWritten, writeEffect } from './effects.js';
import {
  headOf,
  type Row,
  rowOf,
  type SuggestionActor,
  suggestionKernelActor,
  targetOfRow,
} from './read.js';
import { decidedRefusal, rejectReasonRefusal, withdrawRefusal } from './rules.js';
import {
  answer,
  inTx,
  lockTarget,
  movedBase,
  Refused,
  recordDecision,
  type SuggestionOutcome,
} from './write.js';

export { createSuggestion, reviseSuggestion } from './propose.js';
export type { SuggestionOutcome } from './write.js';

/** After the accept committed: the hooks every issue create and field write emit, and the edges' effects. */
async function announceEffect(written: EffectWritten, projectId: string, actor: SuggestionActor) {
  const who = { type: 'user' as const, id: actor.userId, agency: actor.agency };
  if (written.triage) await announceTriage(written.triage, actor);
  for (const id of written.createdIssueIds ?? []) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, id));
    if (issue) await announceIssueCreated(issue, who);
  }
  if (written.relations?.length) {
    await flushIssueRelationEffects(
      { actor: who, createdById: actor.userId },
      projectId,
      written.relations,
    );
  }
  if (written.routeComment) {
    const { issueId, row, authored } = written.routeComment;
    await hooks.emit('commentCreated', {
      issueId,
      projectId,
      actor: who,
      authored,
      commentId: row.id,
      body: row.body,
      parentId: null,
    });
  }
  if (written.updatedIssue?.written.length) {
    const { before } = written.updatedIssue;
    const [after] = await db.select().from(issues).where(eq(issues.id, before.id));
    if (after) {
      await emitIssueFieldUpdate({
        before: { ...before, workState: null },
        after: { ...after, workState: null },
        written: written.updatedIssue.written,
        actor: who,
      });
    }
  }
}

// cm:why workflow issue-lifecycle step `dropped` ("not work: … a duplicate"): accepting a duplicate
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
  let relations: PendingIssueRelation[] = [];
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
          if (decided) throw new Refused([decided]);
          relations = await writeIssueRelations(
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
            from: 'proposed',
            set: { decidedBy: actor.userId, decidedAt: new Date(), reason },
            where: eq(suggestions.id, row.id),
            reason: reason,
            actor: suggestionKernelActor(actor),
            source: 'suggestions',
            returning: ['id'],
          });
          if (decidedAccepted.rows.length === 0) {
            throw notAnEdgeError(SUGGESTION_MACHINE, row.status, 'accepted');
          }
          await recordDecision(tx, row, actor, 'accepted', reason);
        },
      },
    );
  } catch (err) {
    if (err instanceof Refused) return { ok: false, refusals: err.refusals };
    if (err instanceof TransitionError) {
      return { ok: false, refusals: [{ code: err.code, path: '', detail: err.detail }] };
    }
    throw err;
  }
  await announceEffect({ refusals: null, relations }, projectId, actor);
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
    actor,
    projectId,
    'suggestions.approve',
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
      from: 'proposed',
      set: { decidedBy: actor.userId, decidedAt: new Date(), reason },
      where: eq(suggestions.id, row.id),
      reason: reason,
      actor: suggestionKernelActor(actor),
      source: 'suggestions',
      returning: ['id'],
    });
    if (decidedAccepted.rows.length === 0) {
      throw notAnEdgeError(SUGGESTION_MACHINE, row.status, 'accepted');
    }
    await recordDecision(tx, row, actor, 'accepted', reason);
    return null;
  });
  if (stale.reason) {
    await transition(db, SUGGESTION_MACHINE, {
      to: 'stale',
      from: 'proposed',
      set: { decidedAt: new Date(), reason: stale.reason },
      where: eq(suggestions.id, first.id),
      reason: stale.reason,
      actor: suggestionKernelActor(actor),
      source: 'suggestions-stale',
      returning: ['id'],
    });
  }
  if (refusals) return { ok: false, refusals };
  await announceEffect(written, projectId, actor);
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
    actor,
    projectId,
    'suggestions.approve',
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
      from: 'proposed',
      set: { decidedBy: actor.userId, decidedAt: new Date(), reason },
      where: eq(suggestions.id, row.id),
      reason: reason,
      actor: suggestionKernelActor(actor),
      source: 'suggestions',
      returning: ['id'],
    });
    if (decidedRejected.rows.length === 0) {
      throw notAnEdgeError(SUGGESTION_MACHINE, row.status, 'rejected');
    }
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
  await requireCan({ userId: actor.userId }, 'project.write', projectId);
  const refusals = await inTx(async (tx) => {
    const row = await rowOf(tx, projectId, input.id, true);
    const refusal = withdrawRefusal(actor.userId, row.producerId) ?? decidedRefusal(row.status);
    if (refusal) return [refusal];
    const decidedWithdrawn = await transition(tx, SUGGESTION_MACHINE, {
      to: 'withdrawn',
      from: 'proposed',
      set: { decidedAt: new Date(), reason: 'withdrawn by its producer' },
      where: eq(suggestions.id, row.id),
      reason: 'withdrawn by its producer',
      actor: suggestionKernelActor(actor),
      source: 'suggestions',
      returning: ['id'],
    });
    if (decidedWithdrawn.rows.length === 0) {
      throw notAnEdgeError(SUGGESTION_MACHINE, row.status, 'withdrawn');
    }
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
