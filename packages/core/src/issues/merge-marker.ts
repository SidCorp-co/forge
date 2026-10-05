import type { MergeRefusalCode } from '@forge/contracts/issues';
import type { ActorAgency } from '@forge/contracts/permissions';
import { z } from 'zod';
import { db, type Tx } from '../db/client.js';
import { refuser } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import { emitEvents } from '../outbox/index.js';
import type { Actor } from './activity.js';
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
import { contractDrift, postIssueNotice } from './ports.js';
import { findIssueById, type IssueRow } from './read-service.js';
import { collectWorkEvidence, findMissingWorkEvidence } from './work-evidence.js';

type AuditComment = { id: string; body: string; parentId: string | null };

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
  return (await collectWorkEvidence(issueId)).handoffCommitSha;
}

async function writeAuditComment(
  issueId: string,
  authorId: string,
  body: string,
  tx: Tx = db,
): Promise<AuditComment> {
  const row = await postIssueNotice({ issueId, authorId, body }, tx);
  return { id: row.id, body: row.body, parentId: row.parentId };
}

const refuse = refuser<MergeRefusalCode | 'CONTRACT_DRIFT' | 'CONTRACT_LANDING_UNNAMED'>(
  'MERGE_MARK_REFUSED',
);

type MergeMarkerActor = {
  agency: ActorAgency;
  /** Who the audit comment is attributed to. */
  commentAuthorId: string;
  hookActor: Actor;
};

type MergeMarkArgs = {
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
  /** The contract versions the landed work implemented, `<project>/<contract>@<version>` each. */
  contracts?: readonly string[] | undefined;
  actor: MergeMarkerActor;
};

type RepositoryLanding = Extract<CommitLanding, { ok: true }>;
type LandingShape = NonNullable<Awaited<ReturnType<typeof readLandingShape>>>;

/** What a mark left: the row's merge record, the commit only claimed, and where it was read from. */
type Stamp = {
  result: MergeRecord;
  claimedCommit: string | null;
  /** Set only where the repository's commit is the one stamped, never beside a pull request's. */
  readFrom: RepositoryLanding | null;
};

/** The refusals a mark meets before its transaction: the landing shape, the target, contract
 *  drift, and an agent's work evidence, which a commit the repository attributes may stand in for. */
async function preflightMark(
  args: MergeMarkArgs,
  prior: IssueRow,
): Promise<{ shape: LandingShape; fromRepository: RepositoryLanding | null }> {
  const issueId = args.issue.id;
  const shape = await readLandingShape(args.issue.projectId, db);
  if (shape === null) throw refuse('PROJECT_DOCUMENT_NOT_FOUND', SOURCE_UNDECLARED);
  // A landing on a git project is refused below whatever the target, and that refusal names the
  // real fault, so the missing target is not reported ahead of it.
  if (markTargetRequired(shape) && !args.target && !args.landing) {
    throw refuse(
      'TARGET_REQUIRED',
      'target is required: this project lands through git, so name the branch the work merged into',
      '/target',
    );
  }
  const drift = await contractDrift(prior, args.contracts ?? []);
  if (drift) throw refuse(drift.code, drift.detail, '/contracts');
  if (args.actor.agency !== 'agent') return { shape, fromRepository: null };
  const missing = await findMissingWorkEvidence(issueId);
  if (!missing) return { shape, fromRepository: null };
  if (!args.commit || shape !== 'git') throw refuse('NO_WORK_EVIDENCE', missing);
  const read = await readCommitLanding({ issueId, commit: args.commit });
  if (!read.ok) throw refuse(read.code, read.detail, '/commit');
  return { shape, fromRepository: read };
}

/** The merge record a mark writes: an observed merge, the repository's commit, a landing, or a
 *  bare assertion, in that order of what Forge itself can vouch for. */
async function stampMark(
  tx: Tx,
  args: MergeMarkArgs,
  shape: LandingShape,
  fromRepository: RepositoryLanding | null,
): Promise<Stamp> {
  const issueId = args.issue.id;
  const observed = await observedMergeForIssue(tx, issueId);
  const landing = args.landing ?? null;
  const refused = landingMarkRefusal({ shape, landing, observed: observed !== null });
  if (refused) throw refuse(refused.code, refused.detail, '/landing');
  let stamp: Stamp;
  if (observed) {
    const claimed = args.commit ?? null;
    stamp = {
      result: await recordIssueMerge(tx, {
        issueId,
        evidence: {
          kind: 'observed',
          commitSha: observed.commitSha,
          mergedAt: observed.mergedAt,
          landing,
        },
      }),
      claimedCommit:
        claimed && claimed.toLowerCase() !== observed.commitSha.toLowerCase() ? claimed : null,
      readFrom: null,
    };
  } else if (fromRepository) {
    stamp = {
      result: await recordIssueMerge(tx, {
        issueId,
        evidence: {
          kind: 'observed',
          commitSha: fromRepository.sha,
          mergedAt: fromRepository.committedAt,
        },
      }),
      claimedCommit: null,
      readFrom: fromRepository,
    };
  } else if (landing) {
    stamp = {
      result: await recordIssueMerge(tx, {
        issueId,
        evidence: { kind: 'landed', landing, at: args.mergedAt ?? null },
      }),
      claimedCommit: args.commit ?? null,
      readFrom: null,
    };
  } else {
    stamp = {
      result: await recordIssueMerge(tx, {
        issueId,
        evidence: { kind: 'asserted', at: args.mergedAt ?? null },
      }),
      claimedCommit: args.commit ?? (await resolveRecordedCommit(issueId)),
      readFrom: null,
    };
  }
  const standing = standingMarkRefusal({
    sent: landing,
    wrote: stamp.result.wrote,
    held: {
      mergedAt: stamp.result.mergedAt,
      mergedCommitSha: stamp.result.commitSha,
      mergedLanding: stamp.result.landing,
    },
  });
  if (standing) throw refuse(standing.code, standing.detail, '/landing');
  if (args.target) await recordMergeTarget(tx, issueId, args.target);
  return stamp;
}

/**
 * The `closed` guard is the UPDATE's own WHERE, so nothing can close the row between the decision
 * and the write. A zero-row answer is read back rather than guessed at: the row is gone, or it is
 * closed, and anything else is a state those two conditions cannot produce.
 */
async function clearMark(tx: Tx, issueId: string): Promise<void> {
  if (await clearIssueMerge(tx, issueId)) return;
  const still = await findIssueById(issueId);
  if (!still) throw notFound('issue not found');
  const refusal = refuseUnmarkOnClosed(still.status);
  if (!refusal) {
    throw new Error(
      `unmark cleared no row on issue ${issueId}, which is neither missing nor \`closed\` but ` +
        `\`${still.status}\`. The UPDATE's only other condition is the id, so this is a state ` +
        `clearIssueMerge cannot produce and must not be reported as either of them.`,
    );
  }
  throw refuse('UNMARK_REQUIRES_NOT_CLOSED', refusal.detail);
}

/** The audit comment and the two events a mark or unmark leaves, in the caller's transaction. */
async function writeMarkTrail(
  tx: Tx,
  args: MergeMarkArgs,
  prior: IssueRow,
  stamp: Stamp,
): Promise<{ mark: MergeMarkKind; markDetail: string }> {
  const { id: issueId, projectId } = args.issue;
  const { result, claimedCommit, readFrom } = stamp;
  const marking = args.op === 'mark';
  const commit = result.commitSha ?? claimedCommit;
  const label = marking
    ? `mark_merged${args.target ? ` target=${args.target}` : ''}${commit ? ` commit=${commit}` : ''}`
    : 'unmark';
  const unchanged =
    marking && !result.wrote
      ? `\nNOT stamped by this call: merged_at was already ${result.mergedAt?.toISOString() ?? 'set'} and the first stamp wins; \`unmark\` then \`mark\` is the only correction. It does not re-block dependents: those are held by the issue's STATUS and not by this column (ISS-1100)`
      : '';
  // Read off the ROW, not off the branch this call took: docs/modules/issues/merge-mark.md.
  const mark: MergeMarkKind = marking
    ? mergeMarkKindOf({
        mergedAt: result.mergedAt,
        mergedCommitSha: result.commitSha,
        mergedLanding: result.landing,
      })
    : 'unmarked';
  const markDetail = describeMergeMark({
    kind: mark,
    commitSha: result.commitSha,
    claimedCommit,
    landing: result.landing,
    ...(readFrom && result.wrote ? { readFrom } : {}),
  });
  const audit = await writeAuditComment(
    issueId,
    args.actor.commentAuthorId,
    `${label}${args.note ? ` — ${args.note}` : ''}${unchanged}${marking ? `\n${markDetail}` : ''}`,
    tx,
  );
  const actor = args.actor.hookActor;
  await emitEvents(tx, [
    {
      type: 'comment.created',
      payload: {
        issueId,
        projectId,
        actor,
        authored: 'agent',
        commentId: audit.id,
        body: audit.body,
        parentId: audit.parentId,
      },
    },
    {
      type: 'issue.updated',
      payload: {
        issueId,
        projectId,
        actor,
        fields: ['mergedAt', 'mergedCommitSha', 'mergedLanding'],
        before: {
          mergedAt: prior.mergedAt,
          mergedCommitSha: prior.mergedCommitSha,
          mergedLanding: prior.mergedLanding,
        },
        after: {
          mergedAt: result.mergedAt,
          mergedCommitSha: result.commitSha,
          mergedLanding: result.landing,
        },
      },
    },
  ]);
  return { mark, markDetail };
}

export async function applyMergeMarker(args: MergeMarkArgs): Promise<{
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
  const prior = await findIssueById(args.issue.id);
  if (!prior) throw notFound('issue not found');
  const preflight = args.op === 'mark' ? await preflightMark(args, prior) : null;

  // The stamp, its audit comment and both events commit together or not at all.
  const { stamp, mark, markDetail } = await db.transaction(async (tx) => {
    let stamp: Stamp = {
      result: { wrote: true, mergedAt: null, commitSha: null, landing: null },
      claimedCommit: null,
      readFrom: null,
    };
    if (preflight) stamp = await stampMark(tx, args, preflight.shape, preflight.fromRepository);
    else await clearMark(tx, args.issue.id);
    return { stamp, ...(await writeMarkTrail(tx, args, prior, stamp)) };
  });

  const issue = await findIssueById(args.issue.id);
  if (!issue) throw notFound('issue not found');
  if (args.op !== 'mark') return { issue, action: 'unmarked', mark, markDetail };
  return { issue, action: stamp.result.wrote ? 'merged' : 'already_merged', mark, markDetail };
}
