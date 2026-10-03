import { z } from 'zod';
import { db } from '../db/client.js';
import { comments } from '../db/schema.js';
import type { Actor } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import { collectWorkEvidence, findMissingWorkEvidence } from '../pipeline/work-evidence.js';
import type { ActorAgency } from './actor-agency.js';
import { type CommitLanding, readCommitLanding } from './commit-landing.js';
import {
  landingMarkRefusal,
  markTargetRequired,
  readLandingShape,
  SOURCE_UNDECLARED,
  standingMarkRefusal,
} from './landing-evidence.js';
import {
  clearIssueMerge,
  describeMergeMark,
  type MergeMarkKind,
  type MergeRecord,
  mergeMarkKindOf,
  observedMergeForIssue,
  recordIssueMerge,
  recordMergeTarget,
} from './merge-record.js';
import { refuseUnmarkOnClosed } from './merged-at.js';
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
    readonly code:
      | 'NO_WORK_EVIDENCE'
      | 'ISSUE_NOT_FOUND'
      | 'UNMARK_REQUIRES_NOT_CLOSED'
      | 'LANDING_REQUIRED'
      | 'LANDING_NOT_THIS_SHAPE'
      | 'MARK_ALREADY_STANDS'
      | 'TARGET_REQUIRED'
      | 'PROJECT_DOCUMENT_NOT_FOUND'
      | Exclude<CommitLanding, { ok: true }>['code'],
    message: string,
    readonly details?: Record<string, unknown>,
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
  /** Where the work landed outside git; whether this project takes one is `landing-evidence.ts`'s. */
  landing?: string | undefined;
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
  const prior = await findIssueById(before.id);
  if (!prior) throw new MergeMarkerError('ISSUE_NOT_FOUND', 'issue not found');

  let stampResult: MergeRecord = { wrote: true, mergedAt: null, commitSha: null, landing: null };
  /** The commit the caller claimed, where Forge has no merge of its own to put in the column. */
  let claimedCommit: string | null = null;
  let fromRepository: Extract<CommitLanding, { ok: true }> | null = null;
  /** Set only where the repository's commit is the one stamped, never beside a pull request's. */
  let readFrom: Extract<CommitLanding, { ok: true }> | null = null;
  if (args.op === 'mark') {
    const shape = await readLandingShape(db, before.projectId);
    if (shape === null) throw new MergeMarkerError('PROJECT_DOCUMENT_NOT_FOUND', SOURCE_UNDECLARED);
    // A landing on a git project is refused below whatever the target, and that refusal names the
    // real fault, so the missing target is not reported ahead of it.
    if (markTargetRequired(shape) && !args.target && !args.landing) {
      throw new MergeMarkerError('TARGET_REQUIRED', 'target is required');
    }
    // An agent with nothing else behind it may still have landed on the base branch itself, where
    // the commit is the only trace: it counts once the repository says it is this issue's landing.
    if (args.actor.agency === 'agent') {
      const missing = await findMissingWorkEvidence(before.id);
      if (missing) {
        if (!args.commit || shape !== 'git')
          throw new MergeMarkerError('NO_WORK_EVIDENCE', missing);
        const read = await readCommitLanding({ issueId: before.id, commit: args.commit });
        if (!read.ok) throw new MergeMarkerError(read.code, read.detail, read.details);
        fromRepository = read;
      }
    }
    const observed = await observedMergeForIssue(db, before.id);
    const landing = args.landing ?? null;
    const refused = landingMarkRefusal({ shape, landing, observed: observed !== null });
    if (refused) throw new MergeMarkerError(refused.code, refused.detail);
    if (observed) {
      stampResult = await recordIssueMerge(db, {
        issueId: before.id,
        evidence: {
          kind: 'observed',
          commitSha: observed.commitSha,
          mergedAt: observed.mergedAt,
          via: 'event',
          landing,
        },
      });
      const claimed = args.commit ?? null;
      claimedCommit =
        claimed && claimed.toLowerCase() !== observed.commitSha.toLowerCase() ? claimed : null;
    } else if (fromRepository) {
      readFrom = fromRepository;
      stampResult = await recordIssueMerge(db, {
        issueId: before.id,
        evidence: {
          kind: 'observed',
          commitSha: fromRepository.sha,
          mergedAt: fromRepository.committedAt,
          via: 'repository',
        },
      });
    } else if (landing) {
      stampResult = await recordIssueMerge(db, {
        issueId: before.id,
        evidence: { kind: 'landed', landing, at: args.mergedAt ?? null, via: 'mark' },
      });
      claimedCommit = args.commit ?? null;
    } else {
      stampResult = await recordIssueMerge(db, {
        issueId: before.id,
        evidence: { kind: 'asserted', at: args.mergedAt ?? null, via: 'mark' },
      });
      claimedCommit = args.commit ?? (await resolveRecordedCommit(before.id));
    }
    const standing = standingMarkRefusal({
      sent: landing,
      wrote: stampResult.wrote,
      held: {
        mergedAt: stampResult.mergedAt,
        mergedCommitSha: stampResult.commitSha,
        mergedLanding: stampResult.landing,
      },
    });
    if (standing) throw new MergeMarkerError(standing.code, standing.detail, standing.details);
    if (args.target) await recordMergeTarget(db, before.id, args.target);
  } else {
    // The `closed` guard is the UPDATE's own WHERE, so nothing can close the row between the
    // decision and the write. A zero-row answer is read back rather than guessed at: the row is
    // gone, or it is closed, and anything else is a state those two conditions cannot produce.
    if (!(await clearIssueMerge(db, before.id))) {
      const still = await findIssueById(before.id);
      if (!still) throw new MergeMarkerError('ISSUE_NOT_FOUND', 'issue not found');
      const refusal = refuseUnmarkOnClosed(still.status);
      if (!refusal) {
        throw new Error(
          `unmark cleared no row on issue ${before.id}, which is neither missing nor \`closed\` but ` +
            `\`${still.status}\`. The UPDATE's only other condition is the id, so this is a state ` +
            `clearIssueMerge cannot produce and must not be reported as either of them.`,
        );
      }
      throw new MergeMarkerError('UNMARK_REQUIRES_NOT_CLOSED', refusal.detail);
    }
  }

  const commitLabel = stampResult.commitSha
    ? ` commit=${stampResult.commitSha}`
    : claimedCommit
      ? ` commit=${claimedCommit}`
      : '';
  const label =
    args.op === 'mark'
      ? `mark_merged${args.target ? ` target=${args.target}` : ''}${commitLabel}`
      : 'unmark';
  const unchanged =
    args.op === 'mark' && !stampResult.wrote
      ? `\nNOT stamped by this call: merged_at was already ${stampResult.mergedAt?.toISOString() ?? 'set'} and the first stamp wins; \`unmark\` then \`mark\` is the only correction. It does not re-block dependents: those are held by the issue's STATUS and not by this column (ISS-1100)`
      : '';
  // Read off the ROW, not off the branch this call took: docs/modules/issues/merge-mark.md.
  const mark: MergeMarkKind =
    args.op === 'mark'
      ? mergeMarkKindOf({
          mergedAt: stampResult.mergedAt,
          mergedCommitSha: stampResult.commitSha,
          mergedLanding: stampResult.landing,
        })
      : 'unmarked';
  const markDetail = describeMergeMark({
    kind: mark,
    commitSha: stampResult.commitSha,
    claimedCommit,
    landing: stampResult.landing,
    ...(readFrom && stampResult.wrote ? { readFrom } : {}),
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
    fields: ['mergedAt', 'mergedCommitSha', 'mergedLanding'],
    before: {
      mergedAt: prior.mergedAt,
      mergedCommitSha: prior.mergedCommitSha,
      mergedLanding: prior.mergedLanding,
    },
    after: {
      mergedAt: issue.mergedAt,
      mergedCommitSha: issue.mergedCommitSha,
      mergedLanding: issue.mergedLanding,
    },
  });

  if (args.op !== 'mark') return { issue, action: 'unmarked', mark, markDetail };
  return {
    issue,
    action: stampResult.wrote ? 'merged' : 'already_merged',
    mark,
    markDetail,
  };
}
