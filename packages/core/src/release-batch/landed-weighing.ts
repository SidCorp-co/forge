/**
 * How one live criterion's verdict stands on an issue's landed build (`landed-build.ts`): judged at
 * the build itself, at the head of the request that merged as it where the trees are identical, at a
 * later commit holding it (REQ-36 BC-18), or at an earlier one the build descends from, carried there
 * (ISS-845, `landed-carriage.ts`). Every other answer says what it lacks.
 */

import type { MergedHead } from '@forge/contracts/landing-artifacts';
import { landedCommitOf, landedIdentityWhy, verdictEarns } from '@forge/contracts/verdict-identity';
import type { Carriage, CriterionVerdict, StandingCriterion } from '../issues/index.js';
import { otherHeadWhy } from './change-request-build.js';
import type { Holding } from './landed-build.js';
import { carriedToLanding } from './landed-carriage.js';

const short = (sha: string) => sha.slice(0, 12);

/** One live criterion weighed on a landed build: it counts, or why it does not. `carried` says how
 *  a pass at an earlier commit counts on it (`landed-carriage.ts`); absent, it counts where judged. */
export type LandedCriterion =
  | { criterion: number; counts: true; at: string; carried?: string }
  | { criterion: number; counts: false; why: string };

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
 * unless what changed between falls under what it covers (ISS-845, `landed-carriage.ts`). Every
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
): LandedCriterion {
  const no = (why: string): LandedCriterion => ({
    criterion,
    counts: false,
    why: `${why}; it needs a \`pass\` whose identity is commit \`${short(build)}\``,
  });
  if (!verdict) return no('no verdict was recorded for it');
  if (verdict.unverified) return no(verdict.unverified);
  if (!verdictEarns(verdict.verdict)) return no(`its verdict is \`${verdict.verdict}\``);
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

// Where the project's document owes no verdict, a criterion with none is not weighed, and QA may
// judge it after the landing; a verdict that is there is kernel input all the same: one whose
// identity names no commit is refused by name rather than closed over (`landedIdentityWhy`), and so
// is one judged at `build` itself that does not earn, since a missing verdict passes there but a
// recorded fail never does (ISS-630). A verdict at another commit judged another build.
export function heldWhereNoneOwed(
  build: string,
  criteria: readonly StandingCriterion[],
  judgedOn: string | null,
): LandedCriterion[] {
  return criteria.flatMap(({ criterion, verdict }): LandedCriterion[] => {
    if (!verdict?.at) return [];
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
