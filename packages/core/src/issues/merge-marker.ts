import { z } from 'zod';
import { db } from '../db/client.js';
import { projectKinds } from '../db/schema.js';
import type { Actor } from '../pipeline/activity.js';
import { findMissingWorkEvidence, readStandingClaim } from '../pipeline/work-evidence.js';
import type { ActorAgency } from './actor-agency.js';
import { type CommitLanding, readCommitLanding, resolveMarkCommit } from './commit-landing.js';
import {
  type LaterLanding,
  laterLanding,
  markStays,
  movedSentence,
  notDescendantDetail,
  unreadAnswer,
} from './landing-advance.js';
import {
  type LandingShape,
  type Lane,
  landingMarkRefusal,
  laneFrom,
  type MarkDoor,
  markTargetRequired,
  readDeclaredLandingShape,
  readLandingShape,
  standingMarkRefusal,
  UnknownProjectKindError,
} from './landing-evidence.js';
import { targetRequiredDetail } from './merge-input-refusal.js';
import { announceMark } from './merge-mark-announce.js';
import { MergeMarkerError } from './merge-marker-error.js';
import {
  absentStays,
  alreadyMarkedSentence,
  CHANGE_THE_MARK,
  clearIssueMerge,
  describeMergeMark,
  keptClaimRepeat,
  type MergeMarkKind,
  type MergeRecord,
  mergeMarkKindOf,
  NAME_THE_COMMIT,
  namesNoCommitRefusal,
  observedMergeForIssue,
  readMergeColumns,
  recordIssueMerge,
  threadBody,
} from './merge-record.js';
import { refuseUnmarkOnClosed } from './merged-at.js';
import { findIssueById, type IssueRow } from './read-service.js';
import {
  commitWouldStand,
  type Stated,
  stampStated,
  statedAt,
  statedWords,
} from './stated-landing.js';
import { statusForCaller } from './status-sets.js';

export { MergeMarkerError };

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
 * ISS-1350 — what a `git` mark names as its commit is the repository's resolution of it, never the
 * caller's spelling. A commit the repository does not hold, or cannot be read for, is refused by
 * name. A merged pull request's own merge sha is not read again: Forge already holds it. A mark
 * naming no commit records none.
 */
async function recordedClaim(args: {
  projectId: string;
  commit: string | undefined;
  observedSha: string | null;
  /** On an issue already marked, a commit Forge cannot read is answered with where the mark stays
   *  (ISS-1421 round 8): only an unmarked issue is refused, where marking with no commit helps. */
  marked: boolean;
}): Promise<{
  claim: string | null;
  repository: string | null;
  unread?: { commit: string; why: string };
  /** A first mark on a project naming no repository: the commit is kept as a claim nothing
   *  checked, as an agent's is, rather than refused for a check no setting can make (r36). */
  unchecked?: Extract<AgentEvidence, { kind: 'unverified' }>;
}> {
  const { projectId, commit, observedSha } = args;
  if (!commit) return { claim: null, repository: null };
  if (observedSha && commit.toLowerCase() === observedSha.toLowerCase()) {
    return { claim: commit, repository: null };
  }
  const read = await resolveMarkCommit({ projectId, commit });
  if (!read.ok && read.unchecked && !args.marked) {
    return {
      claim: null,
      repository: null,
      unchecked: { kind: 'unverified', commit, ...read.unchecked },
    };
  }
  if (!read.ok && read.unread && args.marked) {
    return { claim: null, repository: null, unread: { commit, why: read.unread.why } };
  }
  if (!read.ok) throw new MergeMarkerError(read.code, read.detail, read.details);
  return { claim: read.sha, repository: read.repository };
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
    "Nothing was marked, because this issue's landing shape changed while the mark was judged. " +
      'Mark it again.',
    { judged, holds: row.declared },
  );
}

/** What an agent's mark rests on where nothing but its commit stands behind it. */
type AgentEvidence =
  | { kind: 'read'; landing: Extract<CommitLanding, { ok: true }> }
  | { kind: 'unverified'; commit: string; why: string; clears: string; noReader: boolean };

/**
 * An agent with nothing else behind it may still have landed: on a git lane on the base branch
 * itself, where the commit is the only trace and counts once the repository says it is this
 * issue's landing (`read`); outside git where the landing it names is, that lane's evidence.
 *
 * Wherever Forge cannot verify the commit (the project declares no way to read its repository, a
 * reader that is configured fails, or no base branch is named) it is kept as a claim naming the
 * cause (`unverified`, ISS-1409); a repository that was read and says no still refuses.
 * A standing claim is verified here, ahead of the work-evidence shortcut it would itself satisfy.
 */
async function agentEvidence(
  issueId: string,
  shape: LandingShape,
  sent: { commit?: string | undefined; landing?: string | undefined },
  door: MarkDoor,
): Promise<AgentEvidence | null> {
  const standing = shape === 'git' ? await readStandingClaim(issueId) : null;
  if (standing) return agentCommit(issueId, sent.commit ?? standing);
  const missing = await findMissingWorkEvidence(issueId, db, 'mark', door);
  if (!missing || (shape === 'outside_git' && sent.landing)) return null;
  if (!sent.commit || shape !== 'git') throw new MergeMarkerError('NO_WORK_EVIDENCE', missing);
  return agentCommit(issueId, sent.commit);
}

async function agentCommit(issueId: string, commit: string): Promise<AgentEvidence> {
  const read = await readCommitLanding({ issueId, commit });
  if (read.ok) return { kind: 'read', landing: read };
  if (read.unreadable) return { kind: 'unverified', commit, ...read.unreadable };
  throw new MergeMarkerError(read.code, read.detail, read.details);
}

/** What `describeMergeMark` is told of an unverified mark: the claim the row KEEPS, and the cause. */
function keptClaim(
  unverified: Extract<AgentEvidence, { kind: 'unverified' }>,
  kept: string | null,
) {
  if (!kept) return null;
  const { why, clears, noReader } = unverified;
  return { commit: kept, why, clears, noReader, notKept: namesAnother(unverified.commit, kept) };
}

/** The commit a call named where it is not the claim the row keeps; an abbreviation of the kept sha is the same commit. */
function namesAnother(named: string, kept: string): string | null {
  const a = named.toLowerCase();
  const b = kept.toLowerCase();
  return a.startsWith(b) || b.startsWith(a) ? null : named;
}

/** A later commit this mark compared with the one the row held; a different landing is refused. */
async function compareLater(
  issue: { id: string; projectId: string; declaredLandingShape: LandingShape | null },
  commit: string | undefined,
  observed: { commitSha: string; mergedAt: Date } | null,
  fromRepository: Extract<CommitLanding, { ok: true }> | null,
  target: string | undefined,
): Promise<LaterLanding | null> {
  const later = await laterLanding(issue, commit, observed, fromRepository, target);
  if (later?.kind === 'refused')
    throw new MergeMarkerError(later.code, later.detail, later.details);
  if (later?.kind === 'other') {
    throw new MergeMarkerError(
      'LANDING_NOT_DESCENDANT',
      notDescendantDetail(later.held, later.candidate),
      { held: later.held, commit: later.candidate },
    );
  }
  return later;
}

export const NOT_MARKED_MERGED_DETAIL =
  'This issue is not marked merged, so there is no mark to remove. Nothing changed.';

/**
 * Clear the mark. The `closed` and the no-mark guards are the UPDATE's own WHERE, so nothing can
 * close or clear the row between the decision and the write. A zero-row answer is read back rather
 * than guessed at: the row is gone, closed or unmarked, and anything else is a state those three
 * conditions cannot produce.
 */
async function unmarkOrRefuse(issueId: string): Promise<void> {
  if (await clearIssueMerge(db, issueId)) return;
  const still = await findIssueById(issueId);
  if (!still) throw new MergeMarkerError('ISSUE_NOT_FOUND', 'issue not found');
  const refusal = refuseUnmarkOnClosed(still.status);
  if (refusal) throw new MergeMarkerError('UNMARK_REQUIRES_NOT_CLOSED', refusal.detail);
  if (still.mergedAt == null) {
    throw new MergeMarkerError('NOT_MARKED_MERGED', NOT_MARKED_MERGED_DETAIL);
  }
  throw new Error(
    `unmark cleared no row on issue ${issueId}, which is neither missing, Closed (closed) nor unmarked but ` +
      `${statusForCaller(still.status)}. The UPDATE's only other condition is the id, so this is a state ` +
      `clearIssueMerge cannot produce and must not be reported as any of them.`,
  );
}

export type MergeMarkerActor = {
  agency: ActorAgency;
  /** Who the audit comment is attributed to. */
  commentAuthorId: string;
  hookActor: Actor;
};

/** What a mark answers: one wording for the call's reply and the thread, read off the row it left. */
function answerWords(a: {
  later: LaterLanding | null;
  mark: MergeMarkKind;
  stamp: MergeRecord;
  kept: ReturnType<typeof keptClaim>;
  repeated: boolean;
  namedUnread: { commit: string; why: string } | null;
  standingDetail: string;
  /** Where a blank repeat could have recorded a commit named under Commit (ISS-1300 r4). */
  correctable: Awaited<ReturnType<typeof commitWouldStand>>;
}): { after: string; unread: string | null; markDetail: string } {
  const named =
    a.later?.kind === 'unread'
      ? { commit: a.later.candidate, why: a.later.why }
      : a.repeated
        ? a.namedUnread
        : null;
  const stays = markStays(a.later, a.mark, a.stamp, named?.commit ?? null);
  const after = a.kept
    ? keptClaimRepeat(a.kept)
    : a.correctable
      ? `${absentStays(a.correctable)} ${NAME_THE_COMMIT}`
      : `${stays} ${CHANGE_THE_MARK}`;
  const held = a.stamp.commitSha ?? a.stamp.claimedCommit;
  const unread = named ? unreadAnswer(stays, named.commit, named.why, held) : null;
  const markDetail = a.repeated
    ? (unread ?? `${alreadyMarkedSentence(a.stamp.mergedAt)}. ${after}`)
    : a.later?.kind === 'moved'
      ? movedSentence(a.later.from, a.later.to)
      : a.standingDetail;
  return { after, unread, markDetail };
}

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
   *  observed. Absent, the mark records no commit. */
  commit?: string | undefined;
  /** Where the work landed outside git; whether this project takes one is `landing-evidence.ts`'s. */
  landing?: string | undefined;
  mergedAt?: Date | null;
  actor: MergeMarkerActor;
  /** The door the mark came through, so a refusal names the field its caller sends. */
  door?: MarkDoor;
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
  /** The commit the landing moved forward from, where this mark moved it (ISS-1421 round 7). */
  movedFrom: string | null;
  /** The whole commit this mark named where no column keeps it; its words show seven characters. */
  namedCommit: string | null;
}> {
  const before = args.issue;
  const door = args.door ?? 'rest';

  let stampResult: MergeRecord = {
    wrote: true,
    mergedAt: null,
    commitSha: null,
    landing: null,
    claimedCommit: null,
    stated: false,
  };
  /** The commit the caller claimed, where Forge has no merge of its own to put in the column. */
  let claimedCommit: string | null = null;
  let fromRepository: Extract<CommitLanding, { ok: true }> | null = null;
  let unverified: Extract<AgentEvidence, { kind: 'unverified' }> | null = null;
  /** Set only where the repository's commit is the one stamped, never beside a pull request's. */
  let readFrom: Extract<CommitLanding, { ok: true }> | null = null;
  /** The repository that holds the claimed commit, where this call read it there. */
  let claimHeldBy: string | null = null;
  let later: LaterLanding | null = null;
  let namedUnread: { commit: string; why: string } | null = null;
  /** A person's commit stamped as the landing, where this call stamped one. */
  let stated: Stated | null = null;
  if (args.op === 'mark') {
    const lane = await markLane(before);
    const shape = lane.shape;
    // A landing on a git lane is refused below whatever the target, and that refusal names the
    // real fault, so the missing target is not reported ahead of it.
    if (markTargetRequired(shape) && !args.target && !args.landing) {
      throw new MergeMarkerError('TARGET_REQUIRED', targetRequiredDetail(door));
    }
    if (args.actor.agency === 'agent') {
      const evidence = await agentEvidence(before.id, shape, args, door);
      if (evidence?.kind === 'read') fromRepository = evidence.landing;
      if (evidence?.kind === 'unverified') unverified = evidence;
    }
    const observed = await observedMergeForIssue(db, before.id);
    const landing = args.landing ?? null;
    const refused = landingMarkRefusal({ lane, landing, observed: observed !== null, door });
    if (refused) throw new MergeMarkerError(refused.code, refused.detail);
    // A first mark naming no commit over a landing the repository lacks would leave the next
    // sweep weighing it, so it is refused naming the act that clears it (ISS-1300 r5).
    const absent = shape === 'git' && !args.commit && !observed && !before.mergedAt;
    const lacking = absent ? await commitWouldStand(before, args.actor.agency) : null;
    if (lacking) {
      const { commit, from: record, repository } = lacking;
      const details = { commit, record, repository };
      throw new MergeMarkerError('LANDING_COMMIT_REQUIRED', namesNoCommitRefusal(lacking), details);
    }
    // Where a git mark said the work landed rides on the mark's own write (ISS-1421 r36).
    const target = shape === 'git' ? args.target?.trim() || undefined : undefined;
    // Every read is taken before the first write, so a refusal leaves the row as it found it.
    const recorded =
      shape === 'git' && !fromRepository && !unverified
        ? await recordedClaim({
            projectId: before.projectId,
            commit: args.commit,
            observedSha: observed?.commitSha ?? null,
            marked: before.mergedAt != null,
          })
        : null;
    if (recorded?.unchecked) unverified = recorded.unchecked;
    const statedStamp = await stampStated(before, { ...args, target }, recorded, observed);
    stated = statedStamp?.stated ?? null;
    later =
      shape === 'git' && !stated
        ? await compareLater(before, args.commit, observed, fromRepository, target)
        : null;
    const readFirst = fromRepository && (await statedAt(before.id, fromRepository.sha));
    if (statedStamp) {
      stampResult = statedStamp.stamp;
    } else if (later?.kind === 'moved') {
      stampResult = { wrote: true, ...(await readMergeColumns(db, before.id)) };
    } else if (recorded?.unread) {
      // A commit nothing could check writes nothing: the mark stays as it stands.
      namedUnread = recorded.unread;
      stampResult = { wrote: false, ...(await readMergeColumns(db, before.id)) };
    } else if (observed && !readFirst) {
      stampResult = await recordIssueMerge(db, {
        issueId: before.id,
        declared: before.declaredLandingShape ?? null,
        ...(target ? { target } : {}),
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
        ...(target ? { target } : {}),
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
        ...(target ? { target } : {}),
        evidence: { kind: 'landed', landing, at: args.mergedAt ?? null, via: 'mark' },
      });
      claimedCommit = args.commit ?? null;
    } else {
      stampResult = await recordIssueMerge(db, {
        issueId: before.id,
        declared: before.declaredLandingShape ?? null,
        ...(target ? { target } : {}),
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
    }
    if (!stampResult.wrote) await refuseMovedLane(before);
    const standing = standingMarkRefusal({
      sent: landing,
      wrote: stampResult.wrote,
      held: {
        mergedAt: stampResult.mergedAt,
        mergedCommitSha: stampResult.commitSha,
        mergedLanding: stampResult.landing,
        mergedCommitStated: stampResult.stated,
      },
    });
    if (standing) throw new MergeMarkerError(standing.code, standing.detail, standing.details);
  } else {
    await unmarkOrRefuse(before.id);
  }

  const repeated = args.op === 'mark' && !stampResult.wrote;
  const correctable =
    repeated && !args.commit && !later && !namedUnread && !stampResult.landing
      ? await commitWouldStand(before, args.actor.agency)
      : null;

  // Read off the ROW, not off the branch this call took: docs/modules/issues/merge-mark.md.
  const mark: MergeMarkKind =
    args.op === 'mark'
      ? mergeMarkKindOf({
          mergedAt: stampResult.mergedAt,
          mergedCommitSha: stampResult.commitSha,
          mergedLanding: stampResult.landing,
          mergedCommitStated: stampResult.stated,
        })
      : 'unmarked';
  const kept = unverified && keptClaim(unverified, stampResult.claimedCommit);
  const standingDetail = describeMergeMark({
    kind: mark,
    commitSha: stampResult.commitSha,
    claimedCommit,
    landing: stampResult.landing,
    unverified: kept,
    ...(readFrom && stampResult.wrote ? { readFrom } : {}),
    claimHeldBy,
    stated: statedWords(stated, stampResult),
  });
  const { after, unread, markDetail } = answerWords({
    later,
    mark,
    stamp: stampResult,
    kept,
    repeated,
    namedUnread,
    standingDetail,
    correctable,
  });
  const said = { stamp: stampResult, claimedCommit, repeated, unread, after, markDetail };
  const issue = await announceMark(before, args, threadBody({ ...args, ...said }));
  if (!issue) throw new MergeMarkerError('ISSUE_NOT_FOUND', 'issue not found');

  const action = args.op !== 'mark' ? 'unmarked' : repeated ? 'already_merged' : 'merged';
  const [movedFrom, namedCommit] = [
    later?.kind === 'moved' ? later.from : null,
    claimedCommit ?? kept?.notKept ?? null,
  ];
  return { issue, action, mark, markDetail, movedFrom, namedCommit };
}
