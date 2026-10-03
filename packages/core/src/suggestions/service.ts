/**
 * Suggestions: what the BA assistant (or an agent proposing a breakdown) writes instead of changing
 * anything — workflow `suggestion-lifecycle` rev 2. A person accepts or rejects; the accept writes
 * the effect in the same transaction, compare-and-set on the target head, and the effect points back
 * (requirement_revisions.from_suggestion_id). A suggestion never makes anything current: a revision
 * it carries lands as a draft, which the requirement's own propose and accept move on.
 */

import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import { requirementRevisions } from '../db/schema-requirements.js';
import {
  type SuggestionKind,
  type SuggestionProducer,
  type SuggestionStatus,
  suggestions,
} from '../db/schema-suggestions.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { resolveIssueRouteRef } from '../issues/issue-route-ref.js';
import { assertProjectAccess, effectiveProjectRole } from '../lib/authz.js';
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
  baseStaleRefusal,
  decidedRefusal,
  deciderRefusal,
  duplicateRefusal,
  fingerprintOf,
  payloadRefusal,
  queueFullRefusal,
  rejectReasonRefusal,
  SUGGESTION_PAYLOADS,
  type SuggestionTargetType,
  withdrawRefusal,
} from './rules.js';

export interface SuggestionActor {
  userId: string;
  agency: ActorAgency;
}

export type SuggestionTargetRef = { requirement: string } | { issue: string };

type Row = typeof suggestions.$inferSelect;

export interface SuggestionView {
  id: string;
  kind: SuggestionKind;
  status: SuggestionStatus;
  target: { type: SuggestionTargetType; id: string };
  baseRevision: number | null;
  payload: unknown;
  payloadVersion: number;
  fingerprint: string;
  producerKind: SuggestionProducer;
  producerId: string | null;
  conversationMessageId: string | null;
  model: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  createdAt: string;
  payloadPurgedAt: string | null;
}

export type SuggestionOutcome =
  | {
      ok: true;
      suggestion: SuggestionView;
      /** What an accept wrote, read back for the caller; never stored on the row. */
      effect?: { requirementId: string; requirement: string; revision: number } | undefined;
      created?: boolean;
    }
  | { ok: false; refusals: NamedRefusal[] };

export const viewOf = (r: Row): SuggestionView => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  target: r.requirementId
    ? { type: 'requirement', id: r.requirementId }
    : { type: 'issue', id: r.issueId as string },
  baseRevision: r.baseRevision,
  payload: r.payload,
  payloadVersion: r.payloadVersion,
  fingerprint: r.fingerprint,
  producerKind: r.producerKind,
  producerId: r.producerId,
  conversationMessageId: r.conversationMessageId,
  model: r.model,
  decidedBy: r.decidedBy,
  decidedAt: r.decidedAt?.toISOString() ?? null,
  reason: r.reason,
  createdAt: r.createdAt.toISOString(),
  payloadPurgedAt: r.payloadPurgedAt?.toISOString() ?? null,
});

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

class Refused extends Error {
  constructor(readonly refusals: NamedRefusal[]) {
    super(refusals.map((r) => r.code).join(', '));
  }
}

/** Runs `body` in one transaction; a thrown `Refused` rolls it back and comes out as refusals. */
async function inTx<T>(
  body: (tx: Tx) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; refusals: NamedRefusal[] }> {
  try {
    return { ok: true, value: await db.transaction((tx) => body(tx)) };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, refusals: err.refusals };
    throw err;
  }
}

async function resolveTarget(
  projectId: string,
  target: SuggestionTargetRef,
  userId: string,
): Promise<{ type: SuggestionTargetType; id: string }> {
  if ('requirement' in target) {
    return { type: 'requirement', id: (await rowIn(db, projectId, target.requirement)).id };
  }
  const issue = await resolveIssueRouteRef(target.issue, projectId, userId);
  if (issue.projectId !== projectId) {
    throw notFound(`issue ${target.issue} is not an issue of project ${projectId}`);
  }
  return { type: 'issue', id: issue.id };
}

const onTarget = (t: { type: SuggestionTargetType; id: string }) =>
  t.type === 'requirement' ? eq(suggestions.requirementId, t.id) : eq(suggestions.issueId, t.id);

/** Serialises every write on one target: a requirement's under its project's requirement lock. */
async function lockTarget(
  tx: Tx,
  projectId: string,
  t: { type: SuggestionTargetType; id: string },
) {
  if (t.type === 'requirement') return lockRequirements(tx, projectId);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`suggestions:${t.id}`}, 0))`,
  );
}

async function headOf(tx: Tx, projectId: string, t: { type: SuggestionTargetType; id: string }) {
  return t.type === 'requirement' ? (await rowIn(tx, projectId, t.id)).currentRevision : null;
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
  const written = await inTx(async (tx) => {
    await lockTarget(tx, projectId, target);
    const stale = baseStaleRefusal(input.baseRevision, await headOf(tx, projectId, target));
    if (stale) throw new Refused([stale]);
    const open = await tx
      .select({ id: suggestions.id, kind: suggestions.kind, fingerprint: suggestions.fingerprint })
      .from(suggestions)
      .where(and(onTarget(target), eq(suggestions.status, 'proposed')));
    const twin = open.find((s) => s.kind === kind && s.fingerprint === fingerprint);
    const refusal = duplicateRefusal(twin?.id ?? null) ?? queueFullRefusal(open.length);
    if (refusal) throw new Refused([refusal]);
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
      .returning();
    if (!row) throw new Error('suggestions: the insert returned no row');
    return row;
  });
  if (!written.ok) return written;
  return { ok: true, suggestion: viewOf(written.value), created: true };
}

async function rowOf(tx: Tx, projectId: string, id: string, lock = false): Promise<Row> {
  const query = tx
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.id, id), eq(suggestions.projectId, projectId)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw notFound(`project ${projectId} holds no suggestion ${id}`);
  return row;
}

async function roleOf(userId: string, projectId: string) {
  return (await effectiveProjectRole(userId, projectId))?.role ?? null;
}

const targetOfRow = (r: Row) =>
  r.requirementId
    ? { type: 'requirement' as const, id: r.requirementId }
    : { type: 'issue' as const, id: r.issueId as string };

/**
 * A person accepts: the effect is written in this transaction, compare-and-set on the head. A moved
 * head marks the row stale and refuses SUGGESTION_BASE_STALE naming both revisions — the stale mark
 * is kept, it is the truth about the row.
 */
export async function acceptSuggestion(input: {
  projectId: string;
  id: string;
  actor: SuggestionActor;
}): Promise<SuggestionOutcome> {
  const { projectId, actor } = input;
  const first = await rowOf(db, projectId, input.id);
  const forbidden = deciderRefusal(
    {
      userId: actor.userId,
      agency: actor.agency,
      role: await roleOf(actor.userId, projectId),
      producerId: first.producerId,
    },
    'accept',
  );
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const target = targetOfRow(first);
  let effect: { requirementId: string; requirement: string; revision: number } | undefined;
  const done = await inTx(async (tx) => {
    await lockTarget(tx, projectId, target);
    if (first.kind === 'requirement_draft') await lockRequirements(tx, projectId);
    const row = await rowOf(tx, projectId, input.id, true);
    const decided = decidedRefusal(row.status);
    if (decided) throw new Refused([decided]);
    const head = await headOf(tx, projectId, target);
    const stale = target.type === 'requirement' ? baseStaleRefusal(row.baseRevision, head) : null;
    if (stale) {
      await tx
        .update(suggestions)
        .set({ status: 'stale', decidedAt: new Date(), reason: stale.detail })
        .where(eq(suggestions.id, row.id));
      return { stale };
    }
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
      if (refusals?.length) throw new Refused(refusals);
      const [written] = await tx
        .select({ revision: requirementRevisions.revision })
        .from(requirementRevisions)
        .where(eq(requirementRevisions.fromSuggestionId, row.id));
      const req = await rowIn(tx, projectId, target.id);
      effect = {
        requirementId: target.id,
        requirement: requirementKey(req.reqSeq),
        revision: written?.revision ?? 0,
      };
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
    }
    if (row.kind === 'requirement_draft') {
      const { title, ...write } = SUGGESTION_PAYLOADS.requirement_draft.schema.parse(row.payload);
      const created = await createRequirementIn(tx, {
        projectId,
        actor,
        title,
        write: { ...(write as RevisionWrite), fromSuggestionId: row.id },
      });
      if (created.refusals?.length) throw new Refused(created.refusals);
      const req = await rowIn(tx, projectId, created.id);
      effect = { requirementId: created.id, requirement: requirementKey(req.reqSeq), revision: 1 };
    }
    const [accepted] = await tx
      .update(suggestions)
      .set({ status: 'accepted', decidedBy: actor.userId, decidedAt: new Date() })
      .where(eq(suggestions.id, row.id))
      .returning();
    return { accepted };
  });
  if (!done.ok) return done;
  if ('stale' in done.value) return { ok: false, refusals: [done.value.stale] };
  const accepted = done.value.accepted;
  if (!accepted) throw new Error('suggestions: the accept returned no row');
  return { ok: true, suggestion: viewOf(accepted), effect };
}

/** Moves a proposed row to `status` under a compare-and-set; a decided row is SUGGESTION_DECIDED. */
async function decide(
  projectId: string,
  id: string,
  set: Partial<typeof suggestions.$inferInsert>,
): Promise<SuggestionOutcome> {
  const [row] = await db
    .update(suggestions)
    .set({ ...set, decidedAt: new Date() })
    .where(
      and(
        eq(suggestions.id, id),
        eq(suggestions.projectId, projectId),
        eq(suggestions.status, 'proposed'),
      ),
    )
    .returning();
  if (row) return { ok: true, suggestion: viewOf(row) };
  const now = await rowOf(db, projectId, id);
  const refusal = decidedRefusal(now.status);
  if (!refusal) throw new Error(`suggestions: ${id} is proposed and still did not move`);
  return { ok: false, refusals: [refusal] };
}

export async function rejectSuggestion(input: {
  projectId: string;
  id: string;
  actor: SuggestionActor;
  reason: string | null | undefined;
}): Promise<SuggestionOutcome> {
  const { projectId, actor } = input;
  const row = await rowOf(db, projectId, input.id);
  const refusal =
    deciderRefusal(
      {
        userId: actor.userId,
        agency: actor.agency,
        role: await roleOf(actor.userId, projectId),
        producerId: row.producerId,
      },
      'reject',
    ) ??
    decidedRefusal(row.status) ??
    rejectReasonRefusal(input.reason);
  if (refusal) return { ok: false, refusals: [refusal] };
  return decide(projectId, row.id, {
    status: 'rejected',
    decidedBy: actor.userId,
    reason: input.reason?.trim() ?? null,
  });
}

export async function withdrawSuggestion(input: {
  projectId: string;
  id: string;
  actor: SuggestionActor;
}): Promise<SuggestionOutcome> {
  const row = await rowOf(db, input.projectId, input.id);
  const refusal = withdrawRefusal(input.actor.userId, row.producerId) ?? decidedRefusal(row.status);
  if (refusal) return { ok: false, refusals: [refusal] };
  return decide(input.projectId, row.id, {
    status: 'withdrawn',
    reason: 'withdrawn by its producer',
  });
}

export async function listSuggestions(input: {
  projectId: string;
  userId: string;
  target?: SuggestionTargetRef | undefined;
  statuses?: readonly SuggestionStatus[] | undefined;
  limit?: number | undefined;
}): Promise<{ suggestions: SuggestionView[]; open: number }> {
  await assertProjectAccess(input.projectId, input.userId, 'viewer');
  const target = input.target
    ? await resolveTarget(input.projectId, input.target, input.userId)
    : null;
  const where = and(
    eq(suggestions.projectId, input.projectId),
    target ? onTarget(target) : undefined,
    input.statuses?.length ? inArray(suggestions.status, [...input.statuses]) : undefined,
  );
  const rows = await db
    .select()
    .from(suggestions)
    .where(where)
    .orderBy(desc(suggestions.createdAt))
    .limit(input.limit ?? 100);
  const [open] = await db
    .select({ n: count() })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.projectId, input.projectId),
        target ? onTarget(target) : undefined,
        eq(suggestions.status, 'proposed'),
      ),
    );
  return { suggestions: rows.map(viewOf), open: open?.n ?? 0 };
}
