import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues } from '../db/schema.js';
import { dispatchTickForProject } from '../jobs/dispatch-tick.js';
import { hooks } from '../pipeline/hooks.js';
import { findMissingWorkEvidence } from '../pipeline/work-evidence.js';
import type { ActorAgency } from './actor-agency.js';
import { findIssueById, type IssueRow } from './read-service.js';

export type AuditComment = { id: string; body: string; parentId: string | null };

/**
 * ISS-286 — idempotent merge stamp. COALESCE keeps the FIRST timestamp, so a
 * repeated call is a no-op on the value and the audit trail records both
 * attempts. `at` overrides the server clock; null uses `now()`.
 */
// cm:why the explicit stamp binds as an ISO string with a `::timestamptz` cast — a bare `sql`${date}`` is an untyped parameter and Postgres cannot infer its type inside COALESCE("merged_at", $1), which was a live 500 on forge-beta for every mergedAt-supplied call
export async function stampIssueMergedAt(issueId: string, at: Date | null): Promise<void> {
  const stampExpr = at ? sql`${at.toISOString()}::timestamptz` : sql`now()`;
  await db
    .update(issues)
    .set({ mergedAt: sql`COALESCE(${issues.mergedAt}, ${stampExpr})`, updatedAt: sql`now()` })
    .where(eq(issues.id, issueId));
}

/** Clearing `merged_at` re-blocks downstream children (ISS-286 AC4). */
export async function clearIssueMergedAt(issueId: string): Promise<void> {
  await db
    .update(issues)
    .set({ mergedAt: null, updatedAt: sql`now()` })
    .where(eq(issues.id, issueId));
}

// cm:guard ISS-820 — `isAi: true` is not cosmetic: a comment written by an automated surface and stored as human releases a `needs_info` bounce, so the issue leaves the state a human was asked to resolve
export async function writeAuditComment(
  issueId: string,
  authorId: string,
  body: string,
): Promise<AuditComment | null> {
  const [row] = await db
    .insert(comments)
    .values({ issueId, authorId, body, parentId: null, isAi: true })
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
  hookActor: { type: 'user' | 'device'; id: string };
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
}): Promise<{ issue: IssueRow; action: 'merged' | 'unmarked' }> {
  const before = args.issue;

  if (args.op === 'mark') {
    if (args.actor.agency === 'agent') {
      const missing = await findMissingWorkEvidence(before.id);
      if (missing) throw new MergeMarkerError('NO_WORK_EVIDENCE', missing);
    }
    await stampIssueMergedAt(before.id, args.mergedAt ?? null);
  } else {
    await clearIssueMergedAt(before.id);
  }

  const label = args.op === 'mark' ? `mark_merged target=${args.target ?? '<unset>'}` : 'unmark';
  const auditComment = await writeAuditComment(
    before.id,
    args.actor.commentAuthorId,
    `${label}${args.note ? ` — ${args.note}` : ''}`,
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
  if (args.op === 'mark') void dispatchTickForProject(before.projectId);

  return { issue, action: args.op === 'mark' ? 'merged' : 'unmarked' };
}
