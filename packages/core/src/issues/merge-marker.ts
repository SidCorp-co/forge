import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues } from '../db/schema.js';
import type { Actor } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import { findMissingWorkEvidence } from '../pipeline/work-evidence.js';
import type { ActorAgency } from './actor-agency.js';
import { findIssueById, type IssueRow } from './read-service.js';

export type AuditComment = { id: string; body: string; parentId: string | null };

/**
 * ISS-286 — idempotent merge stamp. COALESCE keeps the FIRST timestamp, so a
 * repeated call is a no-op on the value. `at` overrides the server clock; null
 * uses `now()`.
 *
 * Returns whether this call is the one that set the value, and the timestamp
 * the row ends up holding either way.
 */
// cm:guard the caller must be TOLD when the stamp did not move, and every caller must pass that on. The first stamp wins, so a later `mark_merged` — a different target, a corrected note, a more accurate time — changes nothing while still answering as though it had, and the audit comment it writes reads as the justification for a timestamp some earlier write set. Measured 2026-09-07 on ISS-925: a throwaway probe set `merged_at`, the real note landed after it, and the timestamp never moved (ISS-940).
// cm:guard `WHERE merged_at IS NULL` is what makes "did this call stamp it" answerable, and it must not go back to COALESCE over the whole row. RETURNING yields the NEW row, so a `merged_at IS NULL` expression in the returning list is evaluated AFTER the write and is false for every mark — the first version of this read that way and would have reported `already_merged` for every genuine stamp. Same predicate the other two writers use (`issues/merged-at.ts`), so all three now agree on how the first stamp wins.
// cm:why the explicit stamp binds as an ISO string with a `::timestamptz` cast — a bare `sql`${date}`` is an untyped parameter whose type Postgres cannot infer, which was a live 500 on forge-beta for every mergedAt-supplied call
export async function stampIssueMergedAt(
  issueId: string,
  at: Date | null,
): Promise<{ stamped: boolean; mergedAt: Date | null }> {
  const stampExpr = at ? sql`${at.toISOString()}::timestamptz` : sql`now()`;
  const [stamped] = await db
    .update(issues)
    .set({ mergedAt: stampExpr, updatedAt: sql`now()` })
    .where(and(eq(issues.id, issueId), isNull(issues.mergedAt)))
    .returning({ mergedAt: issues.mergedAt });
  if (stamped) return { stamped: true, mergedAt: stamped.mergedAt };

  const [existing] = await db
    .select({ mergedAt: issues.mergedAt })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return { stamped: false, mergedAt: existing?.mergedAt ?? null };
}

/** Clearing `merged_at` re-blocks downstream children (ISS-286 AC4). */
export async function clearIssueMergedAt(issueId: string): Promise<void> {
  await db
    .update(issues)
    .set({ mergedAt: null, updatedAt: sql`now()` })
    .where(eq(issues.id, issueId));
}

export async function writeAuditComment(
  issueId: string,
  authorId: string,
  body: string,
): Promise<AuditComment | null> {
  const [row] = await db
    .insert(comments)
    .values({ issueId, authorId, body, parentId: null })
    .returning({ id: comments.id, body: comments.body, parentId: comments.parentId });
  return row ?? null;
}

export class MergeMarkerError extends Error {
  constructor(
    readonly code: 'NO_WORK_EVIDENCE' | 'ISSUE_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'MergeMarkerError';
  }
}

export type MergeMarkerActor = {
  agency: ActorAgency;
  /** Who the audit comment is attributed to. */
  commentAuthorId: string;
  hookActor: Actor;
};

/**
 * ISS-286 — the whole `merged_at` write, for every surface that offers it.
 *
 * `merged_at` is what the feature-branch barrier reads to release a `blocks`
 * parent, so this is a claim that work shipped, not a field edit.
 */
// cm:guard ONE implementation, and the reason is the whole ISS-786 gate: this lived inside the MCP tool, so `POST /api/issues/:id/merge` could only have been a second copy — and a second copy is where the evidence check gets left out, exactly as it was left out of the batch route's actor. The gate reads `agency`, never device-ness, because a job token is an agent writing as the person who queued it.
export async function applyMergeMarker(args: {
  /** Already loaded AND authorised by the caller — this function does neither. */
  issue: { id: string; projectId: string; mergedAt: Date | null };
  op: 'mark' | 'unmark';
  target?: string;
  note?: string | undefined;
  mergedAt?: Date | null;
  actor: MergeMarkerActor;
}): Promise<{ issue: IssueRow; action: 'merged' | 'already_merged' | 'unmarked' }> {
  const before = args.issue;

  let stampResult: { stamped: boolean; mergedAt: Date | null } = { stamped: true, mergedAt: null };
  if (args.op === 'mark') {
    if (args.actor.agency === 'agent') {
      const missing = await findMissingWorkEvidence(before.id);
      if (missing) throw new MergeMarkerError('NO_WORK_EVIDENCE', missing);
    }
    stampResult = await stampIssueMergedAt(before.id, args.mergedAt ?? null);
  } else {
    await clearIssueMergedAt(before.id);
  }

  const label = args.op === 'mark' ? `mark_merged target=${args.target ?? '<unset>'}` : 'unmark';
  // cm:guard the no-op arm must say the timestamp is SOMEBODY ELSE'S. Without it the trail is a note that reads as this call's justification sitting beside a value this call did not write, and a reader correcting a wrong stamp has no way to see that `unmark` then `mark` is the only route — which itself re-blocks every dependent (`clearIssueMergedAt`).
  const unchanged =
    args.op === 'mark' && !stampResult.stamped
      ? ` — NOT stamped by this call: merged_at was already ${stampResult.mergedAt?.toISOString() ?? 'set'} and the first stamp wins; \`unmark\` then \`mark\` is the only correction, and it re-blocks dependents`
      : '';
  const auditComment = await writeAuditComment(
    before.id,
    args.actor.commentAuthorId,
    `${label}${args.note ? ` — ${args.note}` : ''}${unchanged}`,
  );
  if (auditComment) {
    await hooks.emit('commentCreated', {
      issueId: before.id,
      projectId: before.projectId,
      actor: args.actor.hookActor,
      commentId: auditComment.id,
      body: auditComment.body,
      parentId: auditComment.parentId,
    });
  }

  const issue = await findIssueById(before.id);
  if (!issue) throw new MergeMarkerError('ISSUE_NOT_FOUND', 'issue not found');
  await hooks.emit('issueUpdated', {
    issueId: before.id,
    projectId: before.projectId,
    actor: args.actor.hookActor,
    fields: ['mergedAt'],
    before: { mergedAt: before.mergedAt },
    after: { mergedAt: issue.mergedAt },
  });

  // cm:guard the tick is on `mark` ONLY — clearing `merged_at` can only ADD a block, so waking the dispatcher there is work that can never find anything, while skipping it on `mark` leaves a now-unblocked parent waiting out the 60s pg-boss backstop instead of dispatching in ~1s.

  if (args.op !== 'mark') return { issue, action: 'unmarked' };
  return { issue, action: stampResult.stamped ? 'merged' : 'already_merged' };
}
