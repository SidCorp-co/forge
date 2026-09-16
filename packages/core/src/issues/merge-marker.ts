import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { comments, issues } from '../db/schema.js';
import type { Actor } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import { collectWorkEvidence, findMissingWorkEvidence } from '../pipeline/work-evidence.js';
import type { ActorAgency } from './actor-agency.js';
import { findIssueById, type IssueRow } from './read-service.js';

export type AuditComment = { id: string; body: string; parentId: string | null };

/**
 * ISS-959 — the commit a merged mark was made at, on both doors.
 *
 * A sha and nothing else: the field exists so "did THIS commit land?" stops
 * being a judgement call read out of prose, and prose in it would put the
 * judgement straight back. Anything a person wants to say about the landing
 * still goes in `note`, which is what `note` is for.
 */
export const mergedCommitShaSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{7,64}$/i, 'commit must be a git sha: 7 to 64 hex characters, nothing else');

/**
 * ISS-286 — idempotent merge stamp. COALESCE keeps the FIRST timestamp, so a
 * repeated call is a no-op on the value. `at` overrides the server clock; null
 * uses `now()`.
 *
 * Returns whether this call is the one that set the value, and the timestamp
 * the row ends up holding either way.
 */
export async function stampIssueMergedAt(
  issueId: string,
  at: Date | null,
  commitSha: string | null,
): Promise<{ stamped: boolean; mergedAt: Date | null; commitSha: string | null }> {
  const stampExpr = at ? sql`${at.toISOString()}::timestamptz` : sql`now()`;
  const [stamped] = await db
    .update(issues)
    .set({ mergedAt: stampExpr, mergedCommitSha: commitSha, updatedAt: sql`now()` })
    .where(and(eq(issues.id, issueId), isNull(issues.mergedAt)))
    .returning({ mergedAt: issues.mergedAt, mergedCommitSha: issues.mergedCommitSha });
  if (stamped) {
    return { stamped: true, mergedAt: stamped.mergedAt, commitSha: stamped.mergedCommitSha };
  }

  const [existing] = await db
    .select({ mergedAt: issues.mergedAt, mergedCommitSha: issues.mergedCommitSha })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return {
    stamped: false,
    mergedAt: existing?.mergedAt ?? null,
    commitSha: existing?.mergedCommitSha ?? null,
  };
}

/** Clearing `merged_at` re-blocks downstream children (ISS-286 AC4). */
export async function clearIssueMergedAt(issueId: string): Promise<void> {
  await db
    .update(issues)
    .set({ mergedAt: null, mergedCommitSha: null, updatedAt: sql`now()` })
    .where(eq(issues.id, issueId));
}

/**
 * ISS-959 — the commit this mark records, when the caller named none.
 *
 * `forge guide contract earning-and-unearning` requires that anything the
 * repository knows is written onto the issue at the step that knew it, and
 * says of this one: *"the merged mark, which today takes no commit and carries
 * it in the prose of its note"*. Prose is not a field, so the note's form was
 * part of the contract. This is the field, and the fallback is what makes it
 * arrive without every client learning it first.
 */
async function resolveRecordedCommit(issueId: string): Promise<string | null> {
  try {
    const evidence = await collectWorkEvidence(issueId);
    return evidence.handoffCommitSha;
  } catch {
    return null;
  }
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
export async function applyMergeMarker(args: {
  /** Already loaded AND authorised by the caller — this function does neither. */
  issue: { id: string; projectId: string; mergedAt: Date | null };
  op: 'mark' | 'unmark';
  target?: string;
  note?: string | undefined;
  /** The commit this mark was made at. Absent falls back to the recorded handoff sha. */
  commit?: string | undefined;
  mergedAt?: Date | null;
  actor: MergeMarkerActor;
}): Promise<{ issue: IssueRow; action: 'merged' | 'already_merged' | 'unmarked' }> {
  const before = args.issue;

  let stampResult: { stamped: boolean; mergedAt: Date | null; commitSha: string | null } = {
    stamped: true,
    mergedAt: null,
    commitSha: null,
  };
  if (args.op === 'mark') {
    if (args.actor.agency === 'agent') {
      const missing = await findMissingWorkEvidence(before.id);
      if (missing) throw new MergeMarkerError('NO_WORK_EVIDENCE', missing);
    }
    const commit = args.commit ?? (await resolveRecordedCommit(before.id));
    stampResult = await stampIssueMergedAt(before.id, args.mergedAt ?? null, commit);
  } else {
    await clearIssueMergedAt(before.id);
  }

  const commitLabel = stampResult.commitSha ? ` commit=${stampResult.commitSha}` : '';
  const label =
    args.op === 'mark' ? `mark_merged target=${args.target ?? '<unset>'}${commitLabel}` : 'unmark';
  const unchanged =
    args.op === 'mark' && !stampResult.stamped
      ? `\nNOT stamped by this call: merged_at was already ${stampResult.mergedAt?.toISOString() ?? 'set'} and the first stamp wins; \`unmark\` then \`mark\` is the only correction, and it re-blocks dependents`
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
      authored: 'agent',
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
    fields: ['mergedAt', 'mergedCommitSha'],
    before: { mergedAt: before.mergedAt },
    after: { mergedAt: issue.mergedAt, mergedCommitSha: issue.mergedCommitSha },
  });


  if (args.op !== 'mark') return { issue, action: 'unmarked' };
  return { issue, action: stampResult.stamped ? 'merged' : 'already_merged' };
}
