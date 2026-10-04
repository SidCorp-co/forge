/**
 * start -> proposed (workflow `suggestion-lifecycle`): a producer's new suggestion, and a reviewer's
 * revision of a proposed one, which rejects the original in the same write (ISS-117).
 */

import {
  SUGGESTION_PAYLOADS,
  type SuggestionKind,
  type SuggestionProducer,
} from '@forge/contracts/suggestions';
import { and, eq, ne } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { suggestions } from '../db/schema-suggestions.js';
import { assertProjectAccess } from '../lib/authz.js';
import { personActRefusalFor } from '../lib/person-act.js';
import type { NamedRefusal } from '../project-config/respond.js';
import { breakdownGuardIn } from './breakdown.js';
import {
  headOf,
  onTarget,
  resolveTarget,
  rowOf,
  type SuggestionActor,
  type SuggestionTarget,
  type SuggestionTargetRef,
  targetOfRow,
} from './read.js';
import {
  baseStaleRefusal,
  decidedRefusal,
  duplicateRefusal,
  fingerprintOf,
  payloadRefusal,
  queueFullRefusal,
  rejectReasonRefusal,
  reviseProducerRefusal,
  unchangedRevisionRefusal,
} from './rules.js';
import {
  answer,
  inTx,
  lockTarget,
  movedBase,
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
}

/** start -> proposed inside the caller's transaction, which holds the target's lock and checked the
 *  base: a breakdown's guard, no open twin, room in the queue; the row a revision replaces is not
 *  counted, since it leaves `proposed` in the same write. */
async function proposeIn(
  tx: Tx,
  p: Proposal,
  head: number | null,
): Promise<{ refusals: NamedRefusal[] } | { id: string }> {
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
  const refusal = duplicateRefusal(twin?.id ?? null) ?? queueFullRefusal(open.length);
  if (refusal) return { refusals: [refusal] };
  const [row] = await tx
    .insert(suggestions)
    .values({
      projectId: p.projectId,
      kind: p.kind,
      requirementId: p.target.type === 'requirement' ? p.target.id : null,
      issueId: p.target.type === 'issue' ? p.target.id : null,
      feedbackId: p.target.type === 'feedback' ? p.target.id : null,
      baseRevision: p.baseRevision,
      payload: p.payload,
      fingerprint: p.fingerprint,
      revisesId: p.revisesId,
      producerKind: p.producerKind,
      producerId: p.producerId,
      model: p.model,
      conversationMessageId: p.conversationMessageId,
    })
    .returning({ id: suggestions.id });
  if (!row) throw new Error('suggestions: the insert returned no row');
  return { id: row.id };
}

export async function createSuggestion(input: {
  projectId: string;
  actor: SuggestionActor;
  producerKind: SuggestionProducer;
  producerId: string | null;
  kind: SuggestionKind;
  target: SuggestionTargetRef;
  baseRevision: number | null;
  payload: unknown;
  model?: string | null | undefined;
  conversationMessageId?: string | null | undefined;
}): Promise<SuggestionOutcome> {
  const { projectId, kind } = input;
  await assertProjectAccess(projectId, input.actor.userId, 'member');
  const target = await resolveTarget(projectId, input.target, input.actor.userId);
  const invalid = payloadRefusal(kind, target.type, input.payload);
  if (invalid) return { ok: false, refusals: [invalid] };
  const payload = SUGGESTION_PAYLOADS[kind].schema.parse(input.payload);
  let id = '';
  const refusals = await inTx(async (tx) => {
    await lockTarget(tx, projectId, target);
    const head = await headOf(tx, projectId, target);
    const stale = baseStaleRefusal(input.baseRevision, head);
    if (stale) return [stale];
    const proposed = await proposeIn(
      tx,
      {
        projectId,
        kind,
        target,
        baseRevision: input.baseRevision,
        payload,
        fingerprint: fingerprintOf(kind, payload),
        producerKind: input.producerKind,
        producerId: input.producerId,
        model: input.model ?? null,
        conversationMessageId: input.conversationMessageId ?? null,
        revisesId: null,
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

// cm:why decision on design suggestion-lifecycle (ISS-117): a reviewer's edit is a new suggestion
// the reviewer produced, naming the original, which is rejected with the reviewer's reason in the
// same transaction; no state is added, and the two-party rule then holds for the revision as it
// does for any suggestion, so the editor never accepts their own edit
export async function reviseSuggestion(input: {
  projectId: string;
  id: string;
  actor: SuggestionActor;
  payload: unknown;
  reason: string | null | undefined;
}): Promise<SuggestionOutcome> {
  const { projectId, actor } = input;
  const first = await rowOf(db, projectId, input.id);
  const forbidden =
    (await personActRefusalFor(
      actor,
      projectId,
      'revising a suggestion',
      'SUGGESTION_REVISE_FORBIDDEN',
    )) ?? reviseProducerRefusal(actor.userId, first.producerId);
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const target = targetOfRow(first);
  const early =
    rejectReasonRefusal(input.reason) ?? payloadRefusal(first.kind, target.type, input.payload);
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
    const moved = movedBase(row, target, head);
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
        producerKind: 'person',
        producerId: actor.userId,
        model: null,
        conversationMessageId: null,
        revisesId: row.id,
      },
      head,
    );
    if ('refusals' in proposed) return proposed.refusals;
    id = proposed.id;
    const rejected = `${reason} (revised by its reviewer as suggestion ${id})`;
    await tx
      .update(suggestions)
      .set({ status: 'rejected', decidedBy: actor.userId, decidedAt: new Date(), reason: rejected })
      .where(eq(suggestions.id, row.id));
    await recordDecision(tx, row, actor, 'rejected', rejected);
    return null;
  });
  if (stale.reason) {
    await db
      .update(suggestions)
      .set({ status: 'stale', decidedAt: new Date(), reason: stale.reason })
      .where(and(eq(suggestions.id, first.id), eq(suggestions.status, 'proposed')));
  }
  if (refusals) return { ok: false, refusals };
  return answer(id, { created: true });
}
