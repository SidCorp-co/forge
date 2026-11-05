import type { AdoptionHeld } from '@forge/contracts/ecosystem';
import type { MergeRefusalCode } from '@forge/contracts/issues';
import type { FileChange, LandingArtifact, LiveReading } from '@forge/contracts/landing-artifacts';
import type { ActorAgency } from '@forge/contracts/permissions';
import { z } from 'zod';
import { db, type Tx } from '../db/client.js';
import { refuser } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import { emitEvents } from '../outbox/index.js';
import type { Actor } from './activity.js';
import { adoptionPreflight, stampAdoption } from './adoption-mark.js';
import {
  type CommitLanding,
  type CommitReading,
  commitReadingOf,
  readCommitLanding,
  vouchedCommit,
} from './commit-landing.js';
import * as designMark from './design-mark.js';
import { type HostMerge, hostMergeOfMark } from './host-mark.js';
import {
  CLEAR_THE_MARK,
  markArtifacts,
  markReadPaths,
  readLandingShape,
  SOURCE_UNDECLARED,
  standingArtifactsRefusal,
  standingMarkRefusal,
  wholeCommitRefusal,
} from './landing-evidence.js';
import { refuseUncheckedMerge, resolveRecordedCommit, withCarriers } from './mark-preconditions.js';
import { callerRunOf, type MarkSaid, type MarkSaidBy, saidOf, saidSentence } from './mark-said.js';
import { markTrailLabel, NOT_STAMPED, recordMarkTrail } from './mark-trail.js';
import { clearMark, recordStampPaths } from './mark-writes.js';
import { identifiedMergeForIssue } from './merge-identity.js';
import {
  describeAdoptionMark,
  describeMergeMark,
  designOnlyStamp,
  type MergeMarkKind,
  mergeMarkKindOf,
} from './merge-mark-kind.js';
import { type MergeRecord, recordIssueMerge, recordMergeTarget } from './merge-record.js';
import { contractDrift, postIssueNotice } from './ports.js';
import { findIssueById, type IssueRow } from './read-service.js';
import { codeEvidenceOf } from './work-evidence.js';

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

/** The mark's words on the thread; `screenedAt` is the caller's field a refusal points at. */
async function writeAuditComment(
  issueId: string,
  authorId: string,
  body: string,
  tx: Tx = db,
  screenedAt?: string,
): Promise<AuditComment> {
  const row = await postIssueNotice(
    { issueId, authorId, body, ...(screenedAt ? { screenedAt } : {}) },
    tx,
  );
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
  /** The box the call came from, which names the run that holds the issue there; null for a person. */
  box?: string | null;
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
  /** Where the work landed, on any shape: a live URL, a docs store, a CMS entry. Recorded as given. */
  landing?: string | undefined;
  /** What the landing changed, by surface, on any shape. Recorded as given. */
  artifacts?: readonly LandingArtifact[] | undefined;
  /** Where the agent read the work live, and what it answered. Recorded as given (ISS-1017). */
  liveReading?: LiveReading | undefined;
  /** The paths the named commit changed, as the box read them from its checkout (`forge-runner api`). */
  changedPaths?: { commit: string; changes: FileChange[] } | undefined;
  mergedAt?: Date | null;
  /** The contract versions the landed work implemented, `<project>/<contract>@<version>` each. */
  contracts?: readonly string[] | undefined;
  /** The contract versions an issue that changed no code adopted, `<project>/<contract>@<version>`
   *  each: its whole deliverable, read off the project's interface and links (REQ-5 BC-17). */
  adoptions?: readonly string[] | undefined;
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
  /** The target this call named, which an observed row's own target outranks. */
  claimedTarget?: string | null;
  /** The adoption record this mark was read from, where it is one. */
  adopted?: AdoptionHeld[] | null;
  /** What the repository said of the commit the mark names, where it was asked. */
  reading?: CommitReading | null;
};

type Preflight = {
  shape: LandingShape;
  fromRepository: RepositoryLanding | null;
  /** Where the mark names `adoptions`: the record read before the stamp, and the notice of a version approved since (`adoptionPreflight`). */
  adopted?: AdoptionHeld[] | null;
  adoptionDrift?: string | null;
  /** The approved design revisions a mark naming nothing stands on, where the issue carries no code. */
  designs?: designMark.DesignMark | null;
  /** What the repository said of the commit the mark names, where it was asked: a reading, never a
   *  refusal (ISS-1017). */
  reading?: CommitReading | null;
};

/**
 * What a mark asks before its transaction: the project's shape, contract drift, and what the
 * repository says of a commit it names. It refuses no mark for the evidence it lacks — no commit,
 * branch, handoff, target or landing shape — since whether the work is done is the agent's call
 * (owner, 2026-11-05, ISS-1017); what the repository says is recorded as the mark's reading.
 */
async function preflightMark(
  args: MergeMarkArgs,
  prior: IssueRow,
  hostMerge: HostMerge | null,
): Promise<Preflight> {
  const issueId = args.issue.id;
  const shape = await readLandingShape(args.issue.projectId, db);
  if (shape === null) throw refuse('PROJECT_DOCUMENT_NOT_FOUND', SOURCE_UNDECLARED);
  if (args.adoptions)
    return { shape, fromRepository: null, ...(await adoptionPreflight(args, prior)) };
  const drift = await contractDrift(prior, args.contracts ?? []);
  if (drift) throw refuse(drift.code, drift.detail, '/contracts');
  if (hostMerge) return { shape, fromRepository: null };
  const design = shape === 'git' && args.commit ? designOnlyStamp(prior) : null;
  if (design && args.commit) return { shape, ...(await overDesign(args, args.commit, design)) };
  // a mark naming nothing on an issue that carries no code stands on the approved designs it drew
  const designs =
    designMark.namesNothing(args) && (await codeEvidenceOf(issueId)).length === 0
      ? await designMark.designsOfMark(prior)
      : null;
  return { shape, designs, ...(await vouchedCommit({ ...args, issueId, shape })) };
}

/**
 * A commit marked over a design approval's stamp is read from the repository whoever marks it, and
 * stamped as observed beside the revision, so the approval that stamped first never shadows the code
 * that landed after it. Where the repository cannot vouch for it the mark is refused, unless the box
 * sent the paths it read at that commit, which the stamp still takes (`recordReadPaths`).
 */
async function overDesign(
  args: MergeMarkArgs,
  commit: string,
  design: string[],
): Promise<{ fromRepository: RepositoryLanding | null; reading: CommitReading }> {
  const read = await readCommitLanding({ issueId: args.issue.id, commit });
  const reading = commitReadingOf(commit, read);
  if (read.ok) return { fromRepository: read, reading };
  if (args.changedPaths) return { fromRepository: null, reading };
  throw refuse(
    'MARK_ALREADY_STANDS',
    `this issue's mark is the approval of design ${design.join(', ')}, which records no commit, and commit ${commit} was not recorded over it because the repository could not vouch for it (${read.code}: ${read.detail}). Nothing changed. Mark again naming the commit that landed this issue's code, or send the paths the box read at it as \`changedPaths\`.`,
    '/commit',
  );
}

/** The merge record a mark writes: an observed merge, the repository's commit, a landing, or the
 *  agent's assertion, in that order of what Forge itself can vouch for; each keeps the landing and
 *  artifacts the agent named, on any shape. */
async function stampMark(
  tx: Tx,
  args: MergeMarkArgs,
  preflight: Preflight,
  /** The host merge, else a projected one, whose commit is this issue's landing (`merge-identity.ts`). */
  observed: HostMerge | null,
): Promise<Stamp> {
  const { shape, fromRepository } = preflight;
  const issueId = args.issue.id;
  if (preflight.adopted) {
    const result = await stampAdoption(tx, args, { shape, adopted: preflight.adopted, observed });
    if (result.wrote && preflight.adoptionDrift)
      await writeAuditComment(issueId, args.actor.commentAuthorId, preflight.adoptionDrift, tx);
    return {
      result,
      claimedCommit: null,
      readFrom: null,
      claimedTarget: null,
      adopted: preflight.adopted,
    };
  }
  if (preflight.designs && !observed) {
    const result = await designMark.stampDesigns(tx, args, { shape, designs: preflight.designs });
    return { result, claimedCommit: null, readFrom: null, claimedTarget: args.target ?? null };
  }
  const landing = args.landing ?? null;
  const sent = args.artifacts ?? null;
  const named = markArtifacts({ landing, sent });
  if (!named.ok) throw refuse(named.code, named.detail, '/artifacts');
  const artifacts = named.artifacts;
  const read = markReadPaths({
    shape,
    commit: args.commit ?? null,
    sent: args.changedPaths ?? null,
  });
  if (!read.ok) throw refuse(read.code, read.detail, '/changedPaths');
  let stamp: Stamp;
  if (observed) {
    const claimed = args.commit ?? null;
    stamp = {
      result: await recordIssueMerge(tx, {
        issueId,
        via: 'repository',
        actor: args.actor.hookActor,
        evidence: {
          kind: 'observed',
          commitSha: observed.commitSha,
          mergedAt: observed.mergedAt,
          target: observed.target,
          landing,
          artifacts,
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
        via: 'repository',
        actor: args.actor.hookActor,
        evidence: {
          kind: 'observed',
          commitSha: fromRepository.sha,
          mergedAt: fromRepository.committedAt,
          target: fromRepository.branch,
          landing,
          artifacts,
        },
      }),
      claimedCommit: null,
      readFrom: fromRepository,
    };
  } else if (landing) {
    stamp = {
      result: await recordIssueMerge(tx, {
        issueId,
        via: 'mark',
        actor: args.actor.hookActor,
        evidence: { kind: 'landed', landing, at: args.mergedAt ?? null, artifacts },
      }),
      claimedCommit: args.commit ?? null,
      readFrom: null,
    };
  } else {
    stamp = {
      result: await recordIssueMerge(tx, {
        issueId,
        via: 'mark',
        actor: args.actor.hookActor,
        evidence: { kind: 'asserted', at: args.mergedAt ?? null, artifacts },
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
  const standingArtifacts = standingArtifactsRefusal({
    sent: sent ? artifacts : null,
    wrote: stamp.result.wrote,
    held: stamp.result.artifacts,
  });
  if (standingArtifacts) {
    throw refuse(standingArtifacts.code, standingArtifacts.detail, '/artifacts');
  }
  if (read.paths) await recordStampPaths(tx, issueId, read.paths, args.actor.hookActor);
  if (args.target) await recordMergeTarget(tx, issueId, args.target);
  return { ...stamp, claimedTarget: args.target ?? null, reading: preflight.reading ?? null };
}

/** The audit comment a mark or unmark leaves, and an unmark's issue.updated, in the caller's transaction. */
async function writeMarkTrail(
  tx: Tx,
  args: MergeMarkArgs,
  prior: IssueRow,
  stamp: Stamp,
): Promise<{ mark: MergeMarkKind; markDetail: string; said: MarkSaid; by: MarkSaidBy }> {
  const { id: issueId, projectId } = args.issue;
  const { result, claimedCommit, readFrom } = stamp;
  const marking = args.op === 'mark';
  const commit = result.commitSha ?? claimedCommit;
  const label = markTrailLabel(args.op, args.target, commit);
  const unchanged =
    marking && !result.wrote
      ? `\n${NOT_STAMPED}: merged_at was already ${result.mergedAt?.toISOString() ?? 'set'} and the first stamp wins; to correct it, ${CLEAR_THE_MARK}, then mark again. It does not re-block dependents: those are held by the issue's STATUS and not by this column (ISS-1100)`
      : '';
  // Read off the ROW, not off the branch this call took: docs/modules/issues/merge-mark.md.
  const mark: MergeMarkKind = marking
    ? mergeMarkKindOf({
        mergedAt: result.mergedAt,
        mergedCommitSha: result.commitSha,
        mergedLanding: result.landing,
      })
    : 'unmarked';
  // what the call named, as named, and who named it (ISS-1017)
  const said = saidOf(args);
  const reading = stamp.reading ?? null;
  const run = marking ? await callerRunOf(tx, issueId, args.actor.box ?? null) : null;
  const by: MarkSaidBy = { ...args.actor.hookActor, run };
  const kindDetail =
    stamp.adopted && result.wrote
      ? describeAdoptionMark(stamp.adopted)
      : (designMark.designStampDetail(result) ??
        describeMergeMark({
          kind: mark,
          commitSha: result.commitSha,
          claimedCommit,
          landing: result.landing,
          ...(readFrom && result.wrote ? { readFrom } : {}),
          target: result.target,
          claimedTarget: stamp.claimedTarget ?? null,
        }));
  const markDetail = marking ? `${kindDetail}. ${saidSentence(said, reading)}` : kindDetail;
  const audit = await writeAuditComment(
    issueId,
    args.actor.commentAuthorId,
    `${label}${args.note ? ` — ${args.note}` : ''}${unchanged}${marking ? `\n${markDetail}` : ''}`,
    tx,
    args.note ? '/note' : undefined,
  );
  const actor = args.actor.hookActor;
  // The record the trail is read from (`mark-trail.ts`); the comment above is only its words.
  const trail = { issueId, actor, commentId: audit.id };
  await recordMarkTrail(
    tx,
    marking
      ? {
          ...trail,
          op: 'mark',
          target: args.target ?? null,
          commit,
          stamped: result.wrote,
          said,
          run,
          commitReading: reading,
        }
      : { ...trail, op: 'unmark' },
  );
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
    // A mark's issue.updated is the stamp's own, emitted by recordIssueMerge with its via.
    ...(marking
      ? []
      : [
          {
            type: 'issue.updated' as const,
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
        ]),
  ]);
  return { mark, markDetail, said, by };
}

export async function applyMergeMarker(input: MergeMarkArgs): Promise<{
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
  /** What the row's landing names it changed after this call; null where it names nothing structured. */
  artifacts: LandingArtifact[] | null;
  /** What this call named, as named, and who named it (ISS-1017); `{}` where it names nothing. */
  said: MarkSaid;
  by: MarkSaidBy;
  /** What the repository said of the commit this call named, where it was asked; never a refusal. */
  commitReading: CommitReading | null;
}> {
  const prior = await findIssueById(input.issue.id);
  if (!prior) throw notFound('issue not found');
  const args = await withCarriers(input, prior);
  // an adoption has no change request: the record Forge reads is its landing on every shape
  const hostMerge =
    args.op === 'mark' && !args.adoptions
      ? await hostMergeOfMark(args, prior, args.actor.hookActor)
      : null;
  const preflight = args.op === 'mark' ? await preflightMark(args, prior, hostMerge) : null;
  // A commit no host or repository resolved is recorded as the caller's claim, so it is whole.
  const unread = preflight && !hostMerge && !preflight.fromRepository;
  const partial = unread ? wholeCommitRefusal(args.commit) : null;
  if (partial) throw refuse(partial.code, partial.detail, '/commit');
  // the merge check and its review judge a commit, and an adoption record or a design lands none
  const unchecked = preflight && !preflight.adopted && !preflight.designs;
  if (unchecked) await refuseUncheckedMerge(args, prior, preflight.shape);

  const observed =
    hostMerge ??
    (args.op === 'mark'
      ? await identifiedMergeForIssue(args.issue.id, args.actor.hookActor)
      : null);
  // a merge Forge observed is code, which the mark stamps over the designs: it owes the check
  if (preflight?.designs && observed) await refuseUncheckedMerge(args, prior, preflight.shape);

  // The stamp, its audit comment and their events commit together or not at all.
  const { stamp, mark, markDetail, said, by } = await db.transaction(async (tx) => {
    let stamp: Stamp = {
      result: {
        wrote: true,
        mergedAt: null,
        commitSha: null,
        landing: null,
        artifacts: null,
        target: null,
      },
      claimedCommit: null,
      readFrom: null,
    };
    if (preflight) stamp = await stampMark(tx, args, preflight, observed);
    else await clearMark(tx, args.issue.id);
    return { stamp, ...(await writeMarkTrail(tx, args, prior, stamp)) };
  });

  const issue = await findIssueById(args.issue.id);
  if (!issue) throw notFound('issue not found');
  const commitReading = stamp.reading ?? null;
  if (args.op !== 'mark') {
    return {
      issue,
      action: 'unmarked',
      mark,
      markDetail,
      artifacts: null,
      said,
      by,
      commitReading,
    };
  }
  return {
    issue,
    action: stamp.result.wrote ? 'merged' : 'already_merged',
    mark,
    markDetail,
    artifacts: stamp.result.artifacts,
    said,
    by,
    commitReading,
  };
}
