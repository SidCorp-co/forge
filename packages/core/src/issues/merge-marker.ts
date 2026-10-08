import { z } from 'zod';
import { db } from '../db/client.js';
import { comments, projectKinds } from '../db/schema.js';
import type { Actor } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import {
  collectWorkEvidence,
  findMissingWorkEvidence,
  readStandingClaim,
} from '../pipeline/work-evidence.js';
import type { ActorAgency } from './actor-agency.js';
import { type CommitLanding, readCommitLanding, resolveMarkCommit } from './commit-landing.js';
import {
  type LandingShape,
  type Lane,
  landingMarkRefusal,
  laneFrom,
  markTargetRequired,
  readDeclaredLandingShape,
  readLandingShape,
  standingMarkRefusal,
  UnknownProjectKindError,
} from './landing-evidence.js';
import {
  clearIssueMerge,
  describeMergeMark,
  type MergeMarkKind,
  type MergeRecord,
  mergeMarkKindOf,
  observedMergeForIssue,
  recordIssueMerge,
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

/** A commit the handoff recorded that the repository did not resolve, kept off the mark. */
type LeftOut = { commit: string; why: string };

/**
 * ISS-1350 — what a `git` mark names as its commit is the repository's resolution of it, never the
 * caller's spelling. A caller's commit the repository does not hold, or cannot be read for, is
 * refused by name; the handoff's, which the caller never sent, is left off and said to be. A merged
 * pull request's own merge sha is not read again: Forge already holds it.
 */
async function recordedClaim(args: {
  projectId: string;
  issueId: string;
  commit: string | undefined;
  observedSha: string | null;
  fallback: boolean;
}): Promise<{ claim: string | null; repository: string | null; leftOut: LeftOut | null }> {
  const { projectId, commit, observedSha } = args;
  if (commit) {
    if (observedSha && commit.toLowerCase() === observedSha.toLowerCase()) {
      return { claim: commit, repository: null, leftOut: null };
    }
    const read = await resolveMarkCommit({ projectId, commit });
    if (!read.ok) throw new MergeMarkerError(read.code, read.detail, read.details);
    return { claim: read.sha, repository: read.repository, leftOut: null };
  }
  const recorded = args.fallback ? await resolveRecordedCommit(args.issueId) : null;
  if (!recorded) return { claim: null, repository: null, leftOut: null };
  const read = await resolveMarkCommit({ projectId, commit: recorded });
  if (!read.ok)
    return { claim: null, repository: null, leftOut: { commit: recorded, why: read.reason } };
  return { claim: read.sha, repository: read.repository, leftOut: null };
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
      | 'PROJECT_KIND_UNKNOWN'
      | 'LANDING_SHAPE_MOVED'
      | Exclude<CommitLanding, { ok: true }>['code'],
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'MergeMarkerError';
  }
}

/** The lane a mark is judged against: the issue's own declaration, else its project's kind. A kind
 *  Forge does not know is the caller's refusal, never a 500, because the mark cannot be judged and
 *  nothing is written. */
async function markLane(issue: {
  projectId: string;
  declaredLandingShape: LandingShape | null;
}): Promise<Lane> {
  const project = issue.declaredLandingShape == null ? await projectShapeOf(issue.projectId) : null;
  // The thunk is read only where nothing is declared, which is where `project` was read.
  return laneFrom(issue.declaredLandingShape, () => project as LandingShape);
}

async function projectShapeOf(projectId: string): Promise<LandingShape> {
  try {
    return await readLandingShape(db, projectId);
  } catch (err) {
    if (!(err instanceof UnknownProjectKindError)) throw err;
    throw new MergeMarkerError('PROJECT_KIND_UNKNOWN', err.message, {
      projectId,
      kind: err.kind,
      kinds: [...projectKinds],
    });
  }
}

/** A stamp that wrote nothing because the declaration moved after the lane was read is refused by
 *  name: the mark was judged on a lane the issue no longer holds, and nothing was written. */
async function refuseMovedLane(issue: {
  id: string;
  declaredLandingShape: LandingShape | null;
}): Promise<void> {
  const row = await readDeclaredLandingShape(db, issue.id);
  const judged = issue.declaredLandingShape ?? null;
  if (!row || (row.declared ?? null) === judged) return;
  throw new MergeMarkerError(
    'LANDING_SHAPE_MOVED',
    `this issue's \`landingShape\` moved from ${judged ?? 'null'} to ${row.declared ?? 'null'} ` +
      'while this mark was judged, so nothing was marked. Mark it again, and it is judged on the ' +
      'lane the issue holds now.',
    { judged, holds: row.declared },
  );
}

/** What an agent's mark rests on where nothing but its commit stands behind it. */
type AgentEvidence =
  | { kind: 'read'; landing: Extract<CommitLanding, { ok: true }> }
  | { kind: 'unverified'; commit: string; why: string };

/**
 * An agent with nothing else behind it may still have landed: on a git lane on the base branch
 * itself, where the commit is the only trace and counts once the repository says it is this
 * issue's landing (`read`); outside git where the landing it names is, that lane's evidence.
 *
 * Where the project declares no way to read its repository the commit is kept as a claim
 * (`unverified`, ISS-1409); a readable repository saying no, and a reader that fails, still refuse.
 * A standing claim is verified here, ahead of the work-evidence shortcut it would itself satisfy.
 */
async function agentEvidence(
  issueId: string,
  shape: LandingShape,
  sent: { commit?: string | undefined; landing?: string | undefined },
): Promise<AgentEvidence | null> {
  const standing = shape === 'git' ? await readStandingClaim(issueId) : null;
  if (standing) return agentCommit(issueId, sent.commit ?? standing);
  const missing = await findMissingWorkEvidence(issueId, db, 'mark');
  if (!missing || (shape === 'outside_git' && sent.landing)) return null;
  if (!sent.commit || shape !== 'git') throw new MergeMarkerError('NO_WORK_EVIDENCE', missing);
  return agentCommit(issueId, sent.commit);
}

async function agentCommit(issueId: string, commit: string): Promise<AgentEvidence> {
  const read = await readCommitLanding({ issueId, commit });
  if (read.ok) return { kind: 'read', landing: read };
  if (read.unreadable) return { kind: 'unverified', commit, why: read.unreadable.why };
  throw new MergeMarkerError(read.code, read.detail, read.details);
}

/**
 * Clear the mark. The `closed` guard is the UPDATE's own WHERE, so nothing can close the row between
 * the decision and the write. A zero-row answer is read back rather than guessed at: the row is gone,
 * or it is closed, and anything else is a state those two conditions cannot produce.
 */
async function unmarkOrRefuse(issueId: string): Promise<void> {
  if (await clearIssueMerge(db, issueId)) return;
  const still = await findIssueById(issueId);
  if (!still) throw new MergeMarkerError('ISSUE_NOT_FOUND', 'issue not found');
  const refusal = refuseUnmarkOnClosed(still.status);
  if (!refusal) {
    throw new Error(
      `unmark cleared no row on issue ${issueId}, which is neither missing nor \`closed\` but ` +
        `\`${still.status}\`. The UPDATE's only other condition is the id, so this is a state ` +
        `clearIssueMerge cannot produce and must not be reported as either of them.`,
    );
  }
  throw new MergeMarkerError('UNMARK_REQUIRES_NOT_CLOSED', refusal.detail);
}

export type MergeMarkerActor = {
  agency: ActorAgency;
  /** Who the audit comment is attributed to. */
  commentAuthorId: string;
  hookActor: Actor;
};

export async function applyMergeMarker(args: {
  /** Already loaded AND authorised by the caller — this function does neither. */
  issue: {
    id: string;
    projectId: string;
    mergedAt: Date | null;
    /** `issues.declared_landing_shape`, read with the row: the lane is the issue's before the project's. */
    declaredLandingShape: LandingShape | null;
  };
  op: 'mark' | 'unmark';
  target?: string;
  note?: string | undefined;
  /** The commit the CALLER says this mark was made at. On a `git` project the repository resolves
   *  it before anything is written (`recordedClaim`); the column takes only a commit Forge
   *  observed. Absent falls back to the recorded handoff sha. */
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

  let stampResult: MergeRecord = {
    wrote: true,
    mergedAt: null,
    commitSha: null,
    landing: null,
    claimedCommit: null,
  };
  /** The commit the caller claimed, where Forge has no merge of its own to put in the column. */
  let claimedCommit: string | null = null;
  let fromRepository: Extract<CommitLanding, { ok: true }> | null = null;
  let unverified: { commit: string; why: string } | null = null;
  /** Set only where the repository's commit is the one stamped, never beside a pull request's. */
  let readFrom: Extract<CommitLanding, { ok: true }> | null = null;
  /** The repository that holds the claimed commit, where this call read it there. */
  let claimHeldBy: string | null = null;
  let leftOut: LeftOut | null = null;
  if (args.op === 'mark') {
    const lane = await markLane(before);
    const shape = lane.shape;
    // A landing on a git lane is refused below whatever the target, and that refusal names the
    // real fault, so the missing target is not reported ahead of it.
    if (markTargetRequired(shape) && !args.target && !args.landing) {
      throw new MergeMarkerError('TARGET_REQUIRED', 'target is required');
    }
    if (args.actor.agency === 'agent') {
      const evidence = await agentEvidence(before.id, shape, args);
      if (evidence?.kind === 'read') fromRepository = evidence.landing;
      if (evidence?.kind === 'unverified') unverified = evidence;
    }
    const observed = await observedMergeForIssue(db, before.id);
    const landing = args.landing ?? null;
    const refused = landingMarkRefusal({ lane, landing, observed: observed !== null });
    if (refused) throw new MergeMarkerError(refused.code, refused.detail);
    // Every read is taken before the first write, so a refusal leaves the row as it found it.
    const recorded =
      shape === 'git' && !fromRepository && !unverified
        ? await recordedClaim({
            projectId: before.projectId,
            issueId: before.id,
            commit: args.commit,
            observedSha: observed?.commitSha ?? null,
            fallback: !observed,
          })
        : null;
    if (observed) {
      stampResult = await recordIssueMerge(db, {
        issueId: before.id,
        declared: before.declaredLandingShape ?? null,
        evidence: {
          kind: 'observed',
          commitSha: observed.commitSha,
          mergedAt: observed.mergedAt,
          via: 'event',
          landing,
        },
      });
      const claimed = recorded?.claim ?? args.commit ?? null;
      claimedCommit =
        claimed && claimed.toLowerCase() !== observed.commitSha.toLowerCase() ? claimed : null;
    } else if (fromRepository) {
      readFrom = fromRepository;
      stampResult = await recordIssueMerge(db, {
        issueId: before.id,
        declared: before.declaredLandingShape ?? null,
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
        declared: before.declaredLandingShape ?? null,
        evidence: { kind: 'landed', landing, at: args.mergedAt ?? null, via: 'mark' },
      });
      claimedCommit = args.commit ?? null;
    } else {
      stampResult = await recordIssueMerge(db, {
        issueId: before.id,
        declared: before.declaredLandingShape ?? null,
        evidence: {
          kind: 'asserted',
          at: args.mergedAt ?? null,
          via: 'mark',
          unverifiedCommit: unverified?.commit ?? null,
        },
      });
      // Only a `git` lane reaches here: `landingMarkRefusal` holds an `outside_git` mark to a landing.
      claimedCommit = unverified ? null : (recorded?.claim ?? null);
      claimHeldBy = recorded?.claim && recorded.repository ? recorded.repository : null;
      leftOut = recorded?.leftOut ?? null;
    }
    if (!stampResult.wrote) await refuseMovedLane(before);
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
  } else {
    await unmarkOrRefuse(before.id);
  }

  const labelled = stampResult.commitSha ?? claimedCommit ?? stampResult.claimedCommit;
  const commitLabel = labelled ? ` commit=${labelled}` : '';
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
    ...(unverified && stampResult.claimedCommit
      ? { unverified: { commit: stampResult.claimedCommit, why: unverified.why } }
      : {}),
    ...(readFrom && stampResult.wrote ? { readFrom } : {}),
    claimHeldBy,
    leftOut,
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
    before: { mergedAt: before.mergedAt },
    after: {
      mergedAt: issue.mergedAt,
      mergedCommitSha: issue.mergedCommitSha,
      mergedLanding: issue.mergedLanding,
    },
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
