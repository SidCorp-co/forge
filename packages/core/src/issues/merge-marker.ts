import { z } from 'zod';
import { db } from '../db/client.js';
import { comments } from '../db/schema.js';
import type { Actor } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import { collectWorkEvidence, findMissingWorkEvidence } from '../pipeline/work-evidence.js';
import type { ActorAgency } from './actor-agency.js';
import {
  clearIssueMerge,
  describeMergeMark,
  type MergeMarkKind,
  type MergeRecord,
  mergeMarkKindOf,
  observedMergeForIssue,
  recordIssueMerge,
} from './merge-record.js';
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

export async function applyMergeMarker(args: {
  /** Already loaded AND authorised by the caller — this function does neither. */
  issue: { id: string; projectId: string; mergedAt: Date | null };
  op: 'mark' | 'unmark';
  target?: string;
  note?: string | undefined;
  /** The commit the CALLER says this mark was made at. Recorded in the audit trail; the column
   *  takes only a commit Forge observed. Absent falls back to the recorded handoff sha. */
  commit?: string | undefined;
  mergedAt?: Date | null;
  actor: MergeMarkerActor;
}): Promise<{
  issue: IssueRow;
  action: 'merged' | 'already_merged' | 'unmarked';
  /**
   * ISS-1126 — which kind of record this call left, and the sentence saying so.
   *
   * `action` answers "did this call move the row". It has never answered the other question a
   * caller has to know: whether what it just wrote is a merge Forge observed or a claim Forge
   * recorded. The sentence is the same one the audit comment carries, built once, so the trail
   * and the answer cannot disagree.
   */
  mark: MergeMarkKind;
  markDetail: string;
}> {
  const before = args.issue;

  let stampResult: MergeRecord = { wrote: true, mergedAt: null, commitSha: null };
  /** The commit the caller claimed, where Forge has no merge of its own to put in the column. */
  let claimedCommit: string | null = null;
  if (args.op === 'mark') {
    if (args.actor.agency === 'agent') {
      const missing = await findMissingWorkEvidence(before.id);
      if (missing) throw new MergeMarkerError('NO_WORK_EVIDENCE', missing);
    }
    const observed = await observedMergeForIssue(db, before.id);
    if (observed) {
      stampResult = await recordIssueMerge(db, {
        issueId: before.id,
        evidence: {
          kind: 'observed',
          commitSha: observed.commitSha,
          mergedAt: observed.mergedAt,
          via: 'event',
        },
      });
      const claimed = args.commit ?? null;
      claimedCommit =
        claimed && claimed.toLowerCase() !== observed.commitSha.toLowerCase() ? claimed : null;
    } else {
      stampResult = await recordIssueMerge(db, {
        issueId: before.id,
        evidence: { kind: 'asserted', at: args.mergedAt ?? null, via: 'mark' },
      });
      claimedCommit = args.commit ?? (await resolveRecordedCommit(before.id));
    }
  } else {
    await clearIssueMerge(db, before.id);
  }

  const commitLabel = stampResult.commitSha
    ? ` commit=${stampResult.commitSha}`
    : claimedCommit
      ? ` commit=${claimedCommit}`
      : '';
  const label =
    args.op === 'mark' ? `mark_merged target=${args.target ?? '<unset>'}${commitLabel}` : 'unmark';
  const unchanged =
    args.op === 'mark' && !stampResult.wrote
      ? `\nNOT stamped by this call: merged_at was already ${stampResult.mergedAt?.toISOString() ?? 'set'} and the first stamp wins; \`unmark\` then \`mark\` is the only correction. It does not re-block dependents: those are held by the issue's STATUS and not by this column (ISS-1100)`
      : '';
  // ISS-1126 — the mark is read back off the row rather than inferred from which branch ran, so
  // the sentence describes what the issue now HOLDS. Under `already_merged` those differ: this
  // call took the asserted branch and the row may carry a stamp somebody else observed.
  const mark: MergeMarkKind =
    args.op === 'mark'
      ? mergeMarkKindOf({ mergedAt: stampResult.mergedAt, mergedCommitSha: stampResult.commitSha })
      : 'unmarked';
  const markDetail = describeMergeMark({
    kind: mark,
    commitSha: stampResult.commitSha,
    claimedCommit,
  });
  const marked = args.op === 'mark' ? `\n${markDetail}` : '';
  const auditComment = await writeAuditComment(
    before.id,
    args.actor.commentAuthorId,
    `${label}${args.note ? ` — ${args.note}` : ''}${unchanged}${marked}`,
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
  await hooks.emit('contractInputChanged', {
    projectId: before.projectId,
    issueId: before.id,
    reason: args.op === 'mark' ? 'merged mark written' : 'merged mark cleared',
  });

  if (args.op !== 'mark') return { issue, action: 'unmarked', mark, markDetail };
  return {
    issue,
    action: stampResult.wrote ? 'merged' : 'already_merged',
    mark,
    markDetail,
  };
}
