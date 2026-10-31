/**
 * start -> proposed (workflow `suggestion-lifecycle`): a producer's new suggestion, and a reviewer's
 * revision of a proposed one, which rejects the original in the same write (ISS-117).
 */

import { SUGGESTION_MACHINE } from '@forge/contracts/suggestion-machine';
import {
  SUGGESTION_PAYLOADS,
  type SuggestionKind,
  type SuggestionProducer,
} from '@forge/contracts/suggestions';
import { and, eq, ne } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { suggestions } from '../db/schema-suggestions.js';
import {
  rowIn as feedbackRowIn,
  nearestFeedbackOf,
  unchangedTriageRefusal,
} from '../feedback/index.js';
import type { Refusal } from '../lib/refusal.js';
import { movedRow, transition } from '../lifecycle/index.js';
import {
  actorFor,
  permissionFactsOf,
  permissionRefusalFor,
  projectResource,
  requireCan,
} from '../permissions/index.js';
import { designNodesIn, nodeSetRefusals } from '../workflows/index.js';
import { breakdownGuardIn } from './breakdown.js';
import { firstRequirementRefusalsIn } from './first-requirement.js';
import { emitSuggestionProposed } from './proposed-event.js';
import {
  headOf,
  onTarget,
  openBaseOf,
  resolveTarget,
  rowOf,
  type SuggestionActor,
  type SuggestionTarget,
  type SuggestionTargetRef,
  suggestionKernelActor,
  targetOfRow,
} from './read.js';
import { draftPictureRefusalsIn, revisionDiffRefusalsIn } from './revision-diff.js';
import {
  baseRequiredRefusal,
  baseStaleRefusal,
  breakdownOpenRefusal,
  breakdownProposerRefusal,
  decidedRefusal,
  duplicateRefusal,
  fingerprintOf,
  payloadRefusal,
  queueFullRefusal,
  rejectedBeforeRefusal,
  rejectReasonRefusal,
  supersedesUnknownRefusal,
  unchangedRevisionRefusal,
} from './rules.js';
import { markMovedStale } from './stale.js';
import {
  answer,
  inTx,
  lockTarget,
  movedBaseIn,
  recordDecision,
  type SuggestionOutcome,
} from './write.js';

interface Proposal {
  projectId: string;
  kind: SuggestionKind;
  target: SuggestionTarget;
  baseRevision: number | null;
  payload: unknown;
  fingerprint: string;
  producerKind: SuggestionProducer;
  producerId: string | null;
  model: string | null;
  conversationMessageId: string | null;
  revisesId: string | null;
  rationale: string | null;
  supersedesId: string | null;
}

/** start -> proposed inside the caller's transaction, which holds the target's lock and checked the
 *  base: a breakdown's guard, no open twin, room in the queue; the row a revision replaces is not
 *  counted, since it leaves `proposed` in the same write. */
async function proposeIn(
  tx: Tx,
  p: Proposal,
  head: number | null,
): Promise<{ refusals: Refusal[] } | { id: string }> {
  if (p.kind === 'breakdown' && p.target.type === 'requirement') {
    const guard = await breakdownGuardIn(
      tx,
      p.projectId,
      p.target.id,
      head,
      SUGGESTION_PAYLOADS.breakdown.schema.parse(p.payload),
    );
    if (guard.refusals.length) return { refusals: guard.refusals };
  }
  if (p.kind === 'design_change' && p.target.type === 'workflow') {
    const nodes = await designNodesIn(tx, p.projectId, p.target.id);
    const wrong = nodes
      ? nodeSetRefusals(
          nodes,
          SUGGESTION_PAYLOADS.design_change.schema.parse(p.payload),
          '/payload',
        )
      : [];
    if (wrong.length) return { refusals: wrong };
  }
  if (p.kind === 'revision_diff' && p.target.type === 'requirement') {
    const wrong = [
      ...(await revisionDiffRefusalsIn(tx, p.target.id, p.baseRevision, p.payload)),
      ...(await draftPictureRefusalsIn(tx, { ...p, kind: p.kind }, head)),
    ];
    if (wrong.length) return { refusals: wrong };
  }
  if (p.kind === 'requirement_draft') {
    const wrong = [
      ...(await firstRequirementRefusalsIn(tx, p.projectId, p.target, p.payload, p.revisesId)),
      ...(await draftPictureRefusalsIn(tx, { ...p, kind: p.kind }, head)),
    ];
    if (wrong.length) return { refusals: wrong };
  }
  if (p.kind === 'feedback_triage' && p.target.type === 'feedback') {
    const unchanged = await unchangedTriageRefusal(
      tx,
      await feedbackRowIn(tx, p.projectId, p.target.id),
      SUGGESTION_PAYLOADS.feedback_triage.schema.parse(p.payload),
    );
    if (unchanged) return { refusals: [unchanged] };
  }
  const open = await tx
    .select({ id: suggestions.id, kind: suggestions.kind, fingerprint: suggestions.fingerprint })
    .from(suggestions)
    .where(
      and(
        onTarget(p.target),
        eq(suggestions.status, 'proposed'),
        p.revisesId ? ne(suggestions.id, p.revisesId) : undefined,
      ),
    );
  const twin = open.find((s) => s.kind === p.kind && s.fingerprint === p.fingerprint);
  const [rejected] = await tx
    .select({ id: suggestions.id, reason: suggestions.reason })
    .from(suggestions)
    .where(
      and(
        onTarget(p.target),
        eq(suggestions.status, 'rejected'),
        eq(suggestions.kind, p.kind),
        eq(suggestions.fingerprint, p.fingerprint),
      ),
    )
    .limit(1);
  const openBreakdown =
    p.kind === 'breakdown' ? open.find((s) => s.kind === 'breakdown') : undefined;
  const refusal =
    breakdownOpenRefusal(openBreakdown?.id ?? null, head) ??
    duplicateRefusal(twin?.id ?? null) ??
    rejectedBeforeRefusal(rejected ?? null) ??
    queueFullRefusal(open.length);
  if (refusal) return { refusals: [refusal] };
  const [row] = await tx
    .insert(suggestions)
    .values({
      projectId: p.projectId,
      kind: p.kind,
      requirementId: p.target.type === 'requirement' ? p.target.id : null,
      issueId: p.target.type === 'issue' ? p.target.id : null,
      feedbackId: p.target.type === 'feedback' ? p.target.id : null,
      workflowId: p.target.type === 'workflow' ? p.target.id : null,
      baseRevision: p.baseRevision,
      payload: p.payload,
      fingerprint: p.fingerprint,
      revisesId: p.revisesId,
      rationale: p.rationale,
      supersedesId: p.supersedesId,
      producerKind: p.producerKind,
      producerId: p.producerId,
      model: p.model,
      conversationMessageId: p.conversationMessageId,
    })
    .returning({ id: suggestions.id });
  if (!row) throw new Error('suggestions: the insert returned no row');
  await emitSuggestionProposed(tx, {
    projectId: p.projectId,
    suggestionId: row.id,
    kind: p.kind,
    targetKind: p.target.type,
    targetId: p.target.id,
  });
  return { id: row.id };
}

async function heldByProject(tx: Tx, projectId: string, id: string): Promise<boolean> {
  const [held] = await tx
    .select({ id: suggestions.id })
    .from(suggestions)
    .where(and(eq(suggestions.id, id), eq(suggestions.projectId, projectId)));
  return held !== undefined;
}

export async function createSuggestion(input: {
  projectId: string;
  actor: SuggestionActor;
  producerKind: SuggestionProducer;
  producerId: string | null;
  kind: SuggestionKind;
  target: SuggestionTargetRef;
  /** The revision the producer read; left out, core reads the target's base now, at creation. */
  baseRevision?: number | null | undefined;
  payload: unknown;
  model?: string | null | undefined;
  conversationMessageId?: string | null | undefined;
  /** Why it is proposed and the earlier suggestion of the project it supersedes: kept on the row only. */
  rationale?: string | null | undefined;
  supersedes?: string | null | undefined;
}): Promise<SuggestionOutcome> {
  const { projectId, kind } = input;
  await requireCan(actorFor(input.actor.userId), 'project.write', projectResource(projectId));
  if (kind === 'breakdown') {
    const forbidden = breakdownProposerRefusal(
      await permissionFactsOf(input.actor.userId, projectId),
    );
    if (forbidden) return { ok: false, refusals: [forbidden] };
  }
  const target = await resolveTarget(projectId, input.target, input.actor.userId);
  const invalid = payloadRefusal(kind, target.type, input.payload);
  if (invalid) return { ok: false, refusals: [invalid] };
  const parsed = SUGGESTION_PAYLOADS[kind].schema.parse(input.payload);
  // step triage takes the nearest item as an input: core stamps it, or says dedup did not run
  const payload =
    kind === 'feedback_triage' && target.type === 'feedback'
      ? { ...parsed, dedup: await nearestFeedbackOf(projectId, target.id) }
      : parsed;
  let id = '';
  const refusals = await inTx(async (tx) => {
    await lockTarget(tx, projectId, target);
    const head = await headOf(tx, projectId, target);
    const open = await openBaseOf(tx, kind, target);
    const base = input.baseRevision === undefined ? (open?.revision ?? head) : input.baseRevision;
    const unbased = baseRequiredRefusal(base, open?.revision ?? head, target.type);
    if (unbased) return [unbased];
    const stale = baseStaleRefusal(base, head, open);
    if (stale) return [stale];
    const supersedes = input.supersedes ?? null;
    const unknown = supersedesUnknownRefusal(
      supersedes,
      supersedes !== null && (await heldByProject(tx, projectId, supersedes)),
    );
    if (unknown) return [unknown];
    const proposed = await proposeIn(
      tx,
      {
        projectId,
        kind,
        target,
        baseRevision: base,
        payload,
        fingerprint: fingerprintOf(kind, parsed),
        producerKind: input.producerKind,
        producerId: input.producerId,
        model: input.model ?? null,
        conversationMessageId: input.conversationMessageId ?? null,
        revisesId: null,
        rationale: input.rationale ?? null,
        supersedesId: supersedes,
      },
      head,
    );
    if ('refusals' in proposed) return proposed.refusals;
    id = proposed.id;
    return null;
  });
  if (refusals) return { ok: false, refusals };
  return answer(id, { created: true });
}

// Decision on design suggestion-lifecycle (ISS-117): a reviewer's edit is a new suggestion
// the reviewer produced, naming the original, which is rejected with the reviewer's reason in the
// same transaction; no state is added. Revising rejects the original, so it takes
// suggestions.approve like any decision (ADR 0007). Its producer's own edit is the same new
// suggestion, but the original is withdrawn, as only its producer may (rev 3): the author changes
// what they asked and decides nothing, so it takes the project.write a withdraw takes.
export async function reviseSuggestion(input: {
  projectId: string;
  id: string;
  actor: SuggestionActor;
  payload: unknown;
  reason: string | null | undefined;
}): Promise<SuggestionOutcome> {
  const { projectId, actor } = input;
  const first = await rowOf(db, projectId, input.id);
  if (first.kind === 'breakdown') {
    const refusal = breakdownProposerRefusal(await permissionFactsOf(actor.userId, projectId));
    if (refusal) return { ok: false, refusals: [refusal] };
  }
  const byProducer = first.producerId !== null && first.producerId === actor.userId;
  const forbidden = await permissionRefusalFor(
    actorFor(actor.userId, actor.agency),
    byProducer ? 'project.write' : 'suggestions.approve',
    projectResource(projectId),
    byProducer ? 'revising your own suggestion' : 'revising a suggestion',
  );
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const target = targetOfRow(first);
  const early =
    (byProducer ? null : rejectReasonRefusal(input.reason)) ??
    payloadRefusal(first.kind, target.type, input.payload);
  if (early) return { ok: false, refusals: [early] };
  const reason = input.reason?.trim() ?? '';
  const payload = SUGGESTION_PAYLOADS[first.kind].schema.parse(input.payload);
  const fingerprint = fingerprintOf(first.kind, payload);
  const unchanged = unchangedRevisionRefusal(first.fingerprint, fingerprint, first.id);
  if (unchanged) return { ok: false, refusals: [unchanged] };
  let id = '';
  const stale: { reason: string | null } = { reason: null };
  const refusals = await inTx(async (tx) => {
    await lockTarget(tx, projectId, target);
    const row = await rowOf(tx, projectId, input.id, true);
    const head = await headOf(tx, projectId, target);
    const moved = await movedBaseIn(tx, row, target, head);
    if (row.status === 'stale' && moved) return [moved];
    const decided = decidedRefusal(row.status);
    if (decided) return [decided];
    if (moved) {
      stale.reason = moved.detail;
      return [moved];
    }
    const proposed = await proposeIn(
      tx,
      {
        projectId,
        kind: row.kind,
        target,
        baseRevision: row.baseRevision,
        payload,
        fingerprint,
        producerKind: actor.agency === 'agent' ? 'agent' : 'person',
        producerId: actor.userId,
        model: null,
        conversationMessageId: null,
        revisesId: row.id,
        rationale: null,
        supersedesId: null,
      },
      head,
    );
    if ('refusals' in proposed) return proposed.refusals;
    id = proposed.id;
    if (byProducer) {
      const withdrawn = `revised by its producer as suggestion ${id}${reason ? `: ${reason}` : ''}`;
      const decidedWithdrawn = await transition(tx, SUGGESTION_MACHINE, {
        to: 'withdrawn',
        expect: 'proposed',
        set: { decidedAt: new Date(), reason: withdrawn },
        where: eq(suggestions.id, row.id),
        reason: withdrawn,
        actor: suggestionKernelActor(actor),
        source: 'suggestions-revise',
        returning: ['id'],
      });
      movedRow(decidedWithdrawn);
      await recordDecision(tx, row, actor, 'withdrawn');
      return null;
    }
    const rejected = `${reason} (revised by its reviewer as suggestion ${id})`;
    const decidedRejected = await transition(tx, SUGGESTION_MACHINE, {
      to: 'rejected',
      expect: 'proposed',
      set: { decidedBy: actor.userId, decidedAt: new Date(), reason: rejected },
      where: eq(suggestions.id, row.id),
      reason: rejected,
      actor: suggestionKernelActor(actor),
      source: 'suggestions-revise',
      returning: ['id'],
    });
    movedRow(decidedRejected);
    await recordDecision(tx, row, actor, 'rejected', rejected);
    return null;
  });
  if (stale.reason) await markMovedStale(first.id, stale.reason, suggestionKernelActor(actor));
  if (refusals) return { ok: false, refusals };
  return answer(id, { created: true });
}
