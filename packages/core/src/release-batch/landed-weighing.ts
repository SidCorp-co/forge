/**
 * How one live criterion's verdict stands on an issue's landed build (`landed-build.ts`): judged at
 * the build itself, at the head of the request that merged as it where the trees are identical, at a
 * later commit holding it (REQ-36 BC-18), or at an earlier one the build descends from, carried there
 * (ISS-845, `issues/landed-carriage.ts`). Every other answer says what it lacks.
 */

import type { MergedHead } from '@forge/contracts/landing-artifacts';
import {
  liveReleaseHolding,
  type ReleasedLine,
  readOnRelease,
  releaseHoldsIssue,
  releaseNotHoldingWhy,
} from '@forge/contracts/released-line';
import { landedCommitOf, landedIdentityWhy, verdictEarns } from '@forge/contracts/verdict-identity';
import {
  type Carriage,
  type CriterionVerdict,
  carriedToLanding,
  type StandingCriterion,
} from '../issues/index.js';
import { otherHeadWhy } from './change-request-build.js';
import type { Holding } from './landed-build.js';

const short = (sha: string) => sha.slice(0, 12);

/** One live criterion weighed on a landed build: it counts, or why it does not. `carried` says how
 *  a pass at an earlier commit counts on it (`issues/landed-carriage.ts`), or a pass on an earlier
 *  release on the live one; absent, it counts where judged. `release` is the version a pass judged on
 *  a release names, counted on the project's release record (ISS-900), never at a commit. */
export type LandedCriterion =
  | { criterion: number; counts: true; at: string; carried?: string; release?: string }
  | {
      criterion: number;
      counts: false;
      why: string;
      /** Set on a live-only criterion no release holding the issue has shipped yet
       *  (`weighLiveOnly`, ISS-957): it is owed on that release once it ships, and holds none. */
      afterRelease?: true;
      /** Set on a live-only criterion that holds (`weighLiveOnly`): a verdict at a commit never earns
       *  it, so the act that clears it is the one its `why` names, never one at the landing (ISS-967). */
      liveOnly?: true;
    };

/**
 * The whole commit a verdict was judged at, or why it names none, by the one reading coverage shares
 * (contracts `landedCommitOf`); on a project naming its testing environment (`judgedOn`), a runtime
 * verdict at a whole commit names it (REQ-36 BC-18).
 */
export function judgedCommit(
  verdict: CriterionVerdict,
  judgedOn: string | null,
): { sha: string } | { why: string } {
  const at = verdict.at;
  if (!at) return { why: 'it names nothing it was judged against' };
  const named = landedCommitOf(at.kind === 'source' ? 'commit' : at.kind, at.value, judgedOn);
  return 'why' in named ? { why: `it was ${named.why}` } : named;
}

/** Why a verdict at `judged` does not count on `build`, naming both commits, where nothing was read. */
export function otherBuildWhy(judged: string, build: string): string {
  return `it was judged at \`${short(judged)}\`, not at \`${short(build)}\`: a pass at an earlier commit counts only where \`${short(build)}\` is read descending from it, and one at a later head only on a record made at that head`;
}

/**
 * A verdict judged at the head of the request that merged as `build`: it counts for `build` only
 * where Forge read from the host, at the merge, that the head's tree is `build`'s
 * (`issues.merged_head`). Null where `judged` is not that head; otherwise whether it counts, in words.
 */
export function atMergedHead(
  judged: string,
  build: string,
  head: MergedHead | null | undefined,
): { counts: true; words: string } | { counts: false; why: string } | null {
  if (!head || head.sha.toLowerCase() !== judged.toLowerCase()) return null;
  if (head.treeIdentical === true) {
    return {
      counts: true,
      words: `judged at \`${short(judged)}\`, tree-identical to landing \`${short(build)}\``,
    };
  }
  if (head.treeIdentical === false) {
    return {
      counts: false,
      why: `it was judged at \`${short(judged)}\`, the head of the request that landed as \`${short(build)}\`, and the host shows the two trees differ (the base moved under it), so it judged another build`,
    };
  }
  return {
    counts: false,
    why: `it was judged at \`${short(judged)}\`, the head of the request that landed as \`${short(build)}\`, and whether the two trees are identical was not read: ${head.why ?? 'nothing says why'}`,
  };
}

/**
 * One criterion's standing on `build`: a pass or short the verified rule counts, judged at `build`
 * itself, at a later commit holding it, or at an earlier one `build` descends from, carried there
 * unless what changed between falls under what it covers (ISS-845, `issues/landed-carriage.ts`). Every
 * other answer says what it lacks, where its verdict sits and the commit it needed.
 */
export function weighOnLanded(
  build: string,
  { criterion, verdict }: StandingCriterion,
  via: string | null = null,
  head: MergedHead | null = null,
  judgedOn: string | null = null,
  /** Per later commit, whether it holds `build` (`landed-build-holds.ts:laterHoldersOf`); absent, none was asked. */
  holders?: ReadonlyMap<string, Holding>,
  /** Per other commit, what `build` holds of it (`landed-build-holds.ts:earlierCarriageOf`); absent, none was asked. */
  descent?: ReadonlyMap<string, Carriage>,
  /** The project's release record (`issues/criteria-standing.ts`); absent, it keeps none. */
  released: ReleasedLine | null = null,
  /** The issue weighed, which a release must hold for a pass on it to count (ISS-957); null, none is asked. */
  issueId: string | null = null,
): LandedCriterion {
  // on a project weighed on its release record, a pass on the live release counts too, once that
  // release holds the issue: one that predates the change never does (ISS-957)
  const live =
    issueId === null ? (released?.live?.version ?? null) : liveRelease(released, issueId);
  const onLive = live ? `, or one judged on release ${live}` : '';
  const no = (why: string): LandedCriterion => ({
    criterion,
    counts: false,
    why: `${why}; it needs a \`pass\` whose identity is commit \`${short(build)}\`${onLive}`,
  });
  if (!verdict) return no('no verdict was recorded for it');
  if (verdict.unverified) return no(verdict.unverified);
  if (!verdictEarns(verdict.verdict)) return no(`its verdict is \`${verdict.verdict}\``);
  if (verdict.at?.kind === 'release') {
    return onRelease(criterion, verdict.at.value, released, no, issueId);
  }
  const judged = judgedCommit(verdict, judgedOn);
  if ('why' in judged) return no(judged.why);
  if (judged.sha !== build.toLowerCase()) {
    const atHead = atMergedHead(judged.sha, build, head);
    if (atHead?.counts) return { criterion, counts: true, at: judged.sha };
    if (atHead) return no(atHead.why);
    const carried = via
      ? null
      : carriedToLanding(build, judged.sha, verdict.covers, descent?.get(judged.sha));
    if (carried?.kind === 'carried') {
      return { criterion, counts: true, at: judged.sha, carried: carried.words };
    }
    const held = via ? undefined : holders?.get(judged.sha);
    if (held === true) return { criterion, counts: true, at: judged.sha };
    if (carried?.kind === 'refused') return no(carried.why);
    if (carried && (held === undefined || held === false)) return no(carried.why);
    if (held === false) {
      return no(
        `it was judged at \`${short(judged.sha)}\`, which does not hold the landing \`${short(build)}\`, so it judged another build`,
      );
    }
    if (held !== undefined) {
      // neither side was read: the later-head reading first, then whether the landing descends from it
      const descends = descent?.get(judged.sha);
      const nor =
        descends?.kind === 'unread'
          ? `; nor was it read that \`${short(build)}\` descends from it: ${descends.why}`
          : '';
      return no(
        `it was judged at \`${short(judged.sha)}\`, and no record of Forge's says that holds the landing \`${short(build)}\`: ${held.unread}${nor}`,
      );
    }
    return no(via ? otherHeadWhy(judged.sha, build, via) : otherBuildWhy(judged.sha, build));
  }
  return { criterion, counts: true, at: judged.sha };
}

/**
 * A pass judged on release `version`, weighed on the project's release record by the one rule a
 * requirement's coverage reads (`@forge/contracts/released-line:readOnRelease`, ISS-900): it counts
 * while that release, or a later one carrying it, is the one the record says is live. Nothing reads
 * production, and no commit is compared.
 */
function onRelease(
  criterion: number,
  version: string,
  released: ReleasedLine | null,
  no: (why: string) => LandedCriterion,
  issueId: string | null = null,
): LandedCriterion {
  const read = readOnRelease(version, released);
  if (read.notCounted !== null) return no(read.notCounted);
  // a release recorded before the issue landed names none of it, and one that shipped it before its
  // last reopen carried the round it rejected (ISS-967): either way its pass judged another build
  if (issueId !== null && releaseHoldsIssue(released, version, issueId) === false) {
    return no(`it was ${releaseNotHoldingWhy(released, version, issueId)}`);
  }
  const at = `release ${version}`;
  return read.countedAs
    ? { criterion, counts: true, at, release: version, carried: read.countedAs }
    : { criterion, counts: true, at, release: version };
}

// Where the project's document owes no verdict, a criterion with none is not weighed, and QA may
// judge it after the landing; a verdict that is there is kernel input all the same: one whose
// identity names no commit is refused by name rather than closed over (`landedIdentityWhy`), and so
// is one judged at `build` itself that does not earn, since a missing verdict passes there but a
// recorded fail never does (ISS-630). A verdict at another commit judged another build.
export function heldWhereNoneOwed(
  build: string,
  criteria: readonly StandingCriterion[],
  judgedOn: string | null,
  released: ReleasedLine | null = null,
): LandedCriterion[] {
  return criteria.flatMap(({ criterion, verdict }): LandedCriterion[] => {
    if (!verdict?.at) return [];
    if (verdict.at.kind === 'release') {
      // a release verdict is read on the record (ISS-900): a fail on what it says is live never passes
      const live = readOnRelease(verdict.at.value, released).notCounted === null;
      if (!live || verdictEarns(verdict.verdict)) return [];
      const why = `its verdict is \`${verdict.verdict}\`, judged on release ${verdict.at.value}, which the record says is live: where no verdict is owed a missing one passes, a recorded fail never does`;
      return [{ criterion, counts: false, why }];
    }
    const why =
      verdict.at.kind === 'source'
        ? null
        : landedIdentityWhy(verdict.at.kind, verdict.at.value, judgedOn);
    if (why) {
      return [
        {
          criterion,
          counts: false,
          why: `it was ${why}; it needs a verdict whose identity is commit \`${short(build)}\``,
        },
      ];
    }
    const judged = judgedCommit(verdict, judgedOn);
    if (verdictEarns(verdict.verdict) || !('sha' in judged) || judged.sha !== build.toLowerCase()) {
      return [];
    }
    return [
      {
        criterion,
        counts: false,
        why: `its verdict is \`${verdict.verdict}\`, judged at \`${short(build)}\`: where no verdict is owed a missing one passes, a recorded fail never does`,
      },
    ];
  });
}

/** The live release, where its record holds `issueId`; the live one where the line lists no issues. */
function liveRelease(released: ReleasedLine | null, issueId: string): string | null {
  const live = released?.live?.version ?? null;
  if (live === null || releaseHoldsIssue(released, live, issueId) === null) return live;
  return liveReleaseHolding(released, issueId);
}

/**
 * One criterion only the running product shows, on a project whose production names no commit it
 * serves (ISS-957): one the issue's design classes `observable`. At its landing the only honest check
 * is a local build on stub data, so a commit there does not earn it and it holds no release: it is
 * owed on the release that carries the issue once that ships (`afterRelease`), as a `release` verdict
 * on it, read by the one rule every door reads (`onRelease`). Once that release ships it is owed like
 * any other criterion, naming the release to judge it on.
 *
 * A release holds the issue only for the round it carried (`releaseHoldsIssue`, ISS-967): after a
 * reopen and a re-land, the release that shipped the round before is never named, and the criterion is
 * owed after the release that carries the new round. A recorded fail holds the release as everyone's
 * evidence, on the round it judged: one the reopen voided, or judged on a release that carried an
 * earlier round (the finding that caused the reopen), holds nothing once the fix re-lands.
 */
export function weighLiveOnly(
  { criterion, verdict }: StandingCriterion,
  released: ReleasedLine,
  issueId: string,
): LandedCriterion {
  const live = liveReleaseHolding(released, issueId);
  // a recorded fail is everyone's evidence: it holds the release, and its finding routes as any other
  const failed = verdict !== null && failsThisRound(verdict, released, issueId);
  const owed = (why: string): LandedCriterion =>
    live || failed
      ? {
          criterion,
          counts: false,
          why: live
            ? `${why}; it is judged on the running product: judge it on release ${live}, naming \`{ kind: 'release', version: '${live}' }\``
            : `${why}; it is judged on the running product, and a recorded fail holds the release that would carry it`,
          liveOnly: true,
        }
      : {
          criterion,
          counts: false,
          why: `${why}; it is judged on the running product, after the release that carries this issue ships`,
          afterRelease: true,
        };
  if (!verdict) return owed('no verdict was recorded for it');
  if (verdict.unverified) return owed(verdict.unverified);
  if (!verdictEarns(verdict.verdict)) return owed(`its verdict is \`${verdict.verdict}\``);
  if (verdict.at?.kind !== 'release') {
    return owed('it was judged at a build, not on a shipped release');
  }
  return onRelease(criterion, verdict.at.value, released, owed, issueId);
}

/**
 * Whether `verdict` is a fail on the issue's current round: not voided by its last reopen (the only
 * fail the verified rule leaves `unverified`, `issues/standing-on.ts`), and not judged on a release
 * that carried another round of it (`releaseHoldsIssue`, ISS-967).
 */
function failsThisRound(
  verdict: CriterionVerdict,
  released: ReleasedLine,
  issueId: string,
): boolean {
  if (verdict.verdict !== 'fail' || verdict.unverified) return false;
  if (verdict.at?.kind !== 'release') return true;
  return releaseHoldsIssue(released, verdict.at.value, issueId) !== false;
}
