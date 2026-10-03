/**
 * Suggestions (workflow `suggestion-lifecycle` rev 2): what the BA assistant, or an agent proposing a
 * breakdown, writes instead of changing anything. A person accepts or rejects; the accept writes the
 * effect in the same transaction, compare-and-set on the target head, and the effect points back
 * (requirement_revisions.from_suggestion_id). A suggestion never makes anything current: a revision
 * it carries lands as a draft. The guards are `rules.ts`, the reads `read.ts`; each write here runs
 * in one transaction and answers an outcome, refusals named and nothing written.
 */

import {
  SUGGESTION_PAYLOADS,
  type SuggestionEffect,
  type SuggestionKind,
  type SuggestionProducer,
  type SuggestionView,
} from '@forge/contracts/suggestions';
import { and, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { requirementRevisions } from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { writeRecordEvent } from '../issues/record-events/store.js';
import { assertProjectAccess } from '../lib/authz.js';
import { personActRefusalFor } from '../lib/person-act.js';
import type { NamedRefusal } from '../project-config/respond.js';
import { requirementKey, rowIn } from '../requirements/read.js';
import {
  createRequirementIn,
  lockRequirements,
  newDraftRevisionIn,
  openRevisionOf,
  type RevisionWrite,
} from '../requirements/service.js';
import {
  headOf,
  onTarget,
  type Row,
  resolveTarget,
  rowOf,
  type SuggestionActor,
  type SuggestionTarget,
  type SuggestionTargetRef,
  targetOfRow,
  viewOf,
} from './read.js';
import {
  baseStaleRefusal,
  decidedRefusal,
  duplicateRefusal,
  fingerprintOf,
  payloadRefusal,
  producerRefusal,
  queueFullRefusal,
  rejectReasonRefusal,
  withdrawRefusal,
} from './rules.js';

export type SuggestionOutcome =
  | { ok: true; suggestion: SuggestionView; effect?: SuggestionEffect; created?: boolean }
  | { ok: false; refusals: NamedRefusal[] };

class Refused extends Error {
  constructor(readonly refusals: NamedRefusal[]) {
    super(refusals.map((r) => r.code).join(', '));
  }
}

/** Runs `body` in a transaction; refusals it returns or throws roll everything back and come out. */
async function inTx(
  body: (tx: Tx) => Promise<NamedRefusal[] | null | undefined>,
): Promise<NamedRefusal[] | null> {
  try {
    return await db.transaction(async (tx) => {
      const refusals = await body(tx);
      if (refusals?.length) throw new Refused(refusals);
      return null;
    });
  } catch (err) {
    if (err instanceof Refused) return err.refusals;
    throw err;
  }
}

/** Serialises every write on one target: a requirement's under its project's requirement lock. */
async function lockTarget(tx: Tx, projectId: string, t: SuggestionTarget) {
  if (t.type === 'requirement') return lockRequirements(tx, projectId);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`suggestions:${t.id}`}, 0))`,
  );
}

async function answer(id: string, extra: { effect?: SuggestionEffect; created?: boolean } = {}) {
  const [row] = await db.select().from(suggestions).where(eq(suggestions.id, id));
  if (!row) throw new Error(`suggestions: ${id} vanished after its write`);
  return { ok: true as const, suggestion: viewOf(row), ...extra };
}

// cm:why a decision on an issue's suggestion is a typed record event (ISS-56) in the decision's own
// transaction; a requirement has no event stream yet (activity_log is keyed by issue), so there the
// row's status, decided_by, decided_at and reason are the record
async function recordDecision(
  tx: Tx,
  row: Row,
  actor: SuggestionActor,
  outcome: string,
  reason?: string | null,
) {
  if (!row.issueId) return;
  await writeRecordEvent(
    {
      issueId: row.issueId,
      actor: { type: 'user', id: actor.userId, agency: actor.agency },
      kind: 'decision',
      contract: 1,
      fields: [
        { key: 'lead', value: `${row.kind} suggestion ${outcome}` },
        { key: 'suggestion', value: row.id },
        { key: 'outcome', value: outcome },
        ...(reason ? [{ key: 'reason', value: reason }] : []),
      ],
    },
    tx,
  );
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
  const fingerprint = fingerprintOf(kind, payload);
  let id = '';
  const refusals = await inTx(async (tx) => {
    await lockTarget(tx, projectId, target);
    const stale = baseStaleRefusal(input.baseRevision, await headOf(tx, projectId, target));
    if (stale) return [stale];
    const open = await tx
      .select({ id: suggestions.id, kind: suggestions.kind, fingerprint: suggestions.fingerprint })
      .from(suggestions)
      .where(and(onTarget(target), eq(suggestions.status, 'proposed')));
    const twin = open.find((s) => s.kind === kind && s.fingerprint === fingerprint);
    const refusal = duplicateRefusal(twin?.id ?? null) ?? queueFullRefusal(open.length);
    if (refusal) return [refusal];
    const [row] = await tx
      .insert(suggestions)
      .values({
        projectId,
        kind,
        requirementId: target.type === 'requirement' ? target.id : null,
        issueId: target.type === 'issue' ? target.id : null,
        baseRevision: input.baseRevision,
        payload,
        fingerprint,
        producerKind: input.producerKind,
        producerId: input.producerId,
        model: input.model ?? null,
        conversationMessageId: input.conversationMessageId ?? null,
      })
      .returning({ id: suggestions.id });
    if (!row) throw new Error('suggestions: the insert returned no row');
    id = row.id;
    return null;
  });
  if (refusals) return { ok: false, refusals };
  return answer(id, { created: true });
}

/** The effect of accepting `row`, written in the accept's transaction; refusals roll it back. */
async function writeEffect(
  tx: Tx,
  projectId: string,
  row: Row,
  head: number | null,
  actor: SuggestionActor,
): Promise<{ refusals: NamedRefusal[] | null; effect?: SuggestionEffect }> {
  const target = targetOfRow(row);
  if (row.kind === 'revision_diff' && target.type === 'requirement') {
    const write = SUGGESTION_PAYLOADS.revision_diff.schema.parse(row.payload) as RevisionWrite;
    const refusals = await newDraftRevisionIn(tx, {
      requirementId: target.id,
      head,
      open: await openRevisionOf(tx, target.id),
      baseRevision: row.baseRevision,
      actor,
      write: { ...write, fromSuggestionId: row.id },
    });
    if (refusals?.length) return { refusals };
    const [written] = await tx
      .select({ revision: requirementRevisions.revision })
      .from(requirementRevisions)
      .where(eq(requirementRevisions.fromSuggestionId, row.id));
    const req = await rowIn(tx, projectId, target.id);
    await tx
      .update(suggestions)
      .set({
        status: 'stale',
        decidedAt: new Date(),
        reason: `suggestion ${row.id} was accepted as a new draft revision of this requirement`,
      })
      .where(
        and(
          eq(suggestions.requirementId, target.id),
          eq(suggestions.status, 'proposed'),
          sql`${suggestions.id} <> ${row.id}`,
        ),
      );
    return {
      refusals: null,
      effect: {
        requirementId: target.id,
        requirement: requirementKey(req.reqSeq),
        revision: written?.revision ?? 0,
      },
    };
  }
  if (row.kind === 'requirement_draft') {
    const { title, ...write } = SUGGESTION_PAYLOADS.requirement_draft.schema.parse(row.payload);
    const created = await createRequirementIn(tx, {
      projectId,
      actor,
      title,
      write: { ...(write as RevisionWrite), fromSuggestionId: row.id },
    });
    if (created.refusals?.length) return { refusals: created.refusals };
    const req = await rowIn(tx, projectId, created.id);
    return {
      refusals: null,
      effect: { requirementId: created.id, requirement: requirementKey(req.reqSeq), revision: 1 },
    };
  }
  return { refusals: null };
}

/**
 * A person accepts: the effect is written in the same transaction, compare-and-set on the head. A
 * moved head refuses SUGGESTION_BASE_STALE naming both revisions and marks the row stale, which is
 * the truth about it whatever the caller does next.
 */
export async function acceptSuggestion(input: {
  projectId: string;
  id: string;
  actor: SuggestionActor;
}): Promise<SuggestionOutcome> {
  const { projectId, actor } = input;
  const first = await rowOf(db, projectId, input.id);
  const forbidden =
    (await personActRefusalFor(
      actor,
      projectId,
      'accepting a suggestion',
      'SUGGESTION_ACCEPT_FORBIDDEN',
    )) ?? producerRefusal(actor.userId, first.producerId);
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const target = targetOfRow(first);
  let effect: SuggestionEffect | undefined;
  const stale: { reason: string | null } = { reason: null };
  const refusals = await inTx(async (tx) => {
    await lockTarget(tx, projectId, target);
    if (first.kind === 'requirement_draft') await lockRequirements(tx, projectId);
    const row = await rowOf(tx, projectId, input.id, true);
    const decided = decidedRefusal(row.status);
    if (decided) return [decided];
    const head = await headOf(tx, projectId, target);
    const moved = target.type === 'requirement' ? baseStaleRefusal(row.baseRevision, head) : null;
    if (moved) {
      stale.reason = moved.detail;
      return [moved];
    }
    const written = await writeEffect(tx, projectId, row, head, actor);
    if (written.refusals) return written.refusals;
    effect = written.effect;
    await tx
      .update(suggestions)
      .set({ status: 'accepted', decidedBy: actor.userId, decidedAt: new Date() })
      .where(eq(suggestions.id, row.id));
    await recordDecision(tx, row, actor, 'accepted');
    return null;
  });
  if (stale.reason) {
    await db
      .update(suggestions)
      .set({ status: 'stale', decidedAt: new Date(), reason: stale.reason })
      .where(and(eq(suggestions.id, first.id), eq(suggestions.status, 'proposed')));
  }
  if (refusals) return { ok: false, refusals };
  return answer(first.id, effect ? { effect } : {});
}

export async function rejectSuggestion(input: {
  projectId: string;
  id: string;
  actor: SuggestionActor;
  reason: string | null | undefined;
}): Promise<SuggestionOutcome> {
  const { projectId, actor } = input;
  const forbidden = await personActRefusalFor(
    actor,
    projectId,
    'rejecting a suggestion',
    'SUGGESTION_ACCEPT_FORBIDDEN',
  );
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const early = rejectReasonRefusal(input.reason);
  if (early) return { ok: false, refusals: [early] };
  const reason = input.reason?.trim() ?? null;
  const refusals = await inTx(async (tx) => {
    const row = await rowOf(tx, projectId, input.id, true);
    const decided = decidedRefusal(row.status);
    if (decided) return [decided];
    await tx
      .update(suggestions)
      .set({ status: 'rejected', decidedBy: actor.userId, decidedAt: new Date(), reason })
      .where(eq(suggestions.id, row.id));
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
  const refusals = await inTx(async (tx) => {
    const row = await rowOf(tx, projectId, input.id, true);
    const refusal = withdrawRefusal(actor.userId, row.producerId) ?? decidedRefusal(row.status);
    if (refusal) return [refusal];
    await tx
      .update(suggestions)
      .set({ status: 'withdrawn', decidedAt: new Date(), reason: 'withdrawn by its producer' })
      .where(eq(suggestions.id, row.id));
    await recordDecision(tx, row, actor, 'withdrawn');
    return null;
  });
  if (refusals) return { ok: false, refusals };
  return answer(input.id);
}
