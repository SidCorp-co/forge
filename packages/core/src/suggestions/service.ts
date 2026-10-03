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
  type SuggestionKind,
  type SuggestionProducer,
  type SuggestionView,
} from '@forge/contracts/suggestions';
import { and, eq, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import { suggestions } from '../db/schema-suggestions.js';
import { lockFeedback } from '../feedback/service.js';
import { announceTriage } from '../feedback/triage.js';
import { TransitionError, transitionIssueStatus } from '../issues/apply-transition.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { resolveIssueRouteRef } from '../issues/issue-route-ref.js';
import { writeRecordEvent } from '../issues/record-events/store.js';
import {
  flushIssueRelationEffects,
  type PendingIssueRelation,
  writeIssueRelations,
} from '../issues/relations-service.js';
import { emitIssueFieldUpdate } from '../issues/update-hook.js';
import { assertProjectAccess } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { personActRefusalFor } from '../lib/person-act.js';
import { hooks } from '../pipeline/hooks.js';
import type { NamedRefusal } from '../project-config/respond.js';
import { lockRequirements } from '../requirements/service.js';
import { type AcceptChannel, type Effect, type EffectWritten, writeEffect } from './effects.js';
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
  | { ok: true; suggestion: SuggestionView; effect?: Effect; created?: boolean }
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

/** Serialises every write on one target: a requirement's under its project's requirement lock, a feedback item's under its feedback lock. */
async function lockTarget(tx: Tx, projectId: string, t: SuggestionTarget) {
  if (t.type === 'requirement') return lockRequirements(tx, projectId);
  if (t.type === 'feedback') return lockFeedback(tx, projectId);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`suggestions:${t.id}`}, 0))`,
  );
}

async function answer(id: string, extra: { effect?: Effect; created?: boolean } = {}) {
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
        feedbackId: target.type === 'feedback' ? target.id : null,
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

/** After the accept committed: the hooks every issue create and field write emit, and the edges' effects. */
async function announceEffect(written: EffectWritten, projectId: string, actor: SuggestionActor) {
  const who = { type: 'user' as const, id: actor.userId, agency: actor.agency };
  if (written.triage) await announceTriage(written.triage, actor);
  for (const id of written.createdIssueIds ?? []) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, id));
    if (!issue) continue;
    await hooks.emit('issueCreated', {
      issueId: issue.id,
      projectId: issue.projectId,
      actor: who,
      status: issue.status as IssueStatus,
      snapshot: {
        title: issue.title,
        description: issue.description,
        descriptionFormat: issue.descriptionFormat,
        priority: issue.priority,
        category: issue.category,
        reportedBy: issue.reportedBy,
        assigneeId: issue.assigneeId,
        labels: [],
      },
    });
  }
  if (written.relations?.length) {
    await flushIssueRelationEffects(
      { actor: who, createdById: actor.userId },
      projectId,
      written.relations,
    );
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

/** A suggestion's base names a revision the head has moved past: the refusal names both. */
function movedBase(row: Row, target: SuggestionTarget, head: number | null) {
  return target.type === 'requirement' ? baseStaleRefusal(row.baseRevision, head) : null;
}

// cm:why workflow issue-lifecycle step `dropped` ("not work: … a duplicate"): accepting a duplicate
// on an issue drops it with the root named and a relates edge to it, through the one transition
// writer; the accept is written inside that transition's transaction, so neither lands alone
async function acceptDuplicateOfIssue(
  projectId: string,
  first: Row,
  actor: SuggestionActor,
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
          await tx
            .update(suggestions)
            .set({ status: 'accepted', decidedBy: actor.userId, decidedAt: new Date() })
            .where(eq(suggestions.id, row.id));
          await recordDecision(tx, row, actor, 'accepted');
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
  if (first.kind === 'duplicate' && target.type === 'issue' && first.status === 'proposed') {
    return acceptDuplicateOfIssue(projectId, first, actor);
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
  await assertProjectAccess(projectId, actor.userId, 'member');
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
