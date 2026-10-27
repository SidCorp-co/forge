/**
 * What a verdict names as the thing it was judged against, and whether coverage can count it there:
 * the live build's hold on a commit or a runtime, a project's landed build where it has no production
 * environment, the pinned design revision or contract version (`standing-coverage.ts:coverageOf`).
 * Pure, so every rule below is a unit test (`standing-coverage.test.ts`).
 */

import type { MergedHead } from '@forge/contracts/landing-artifacts';
import {
  landedIdentityWhy,
  type StorefrontDraftPart,
  storefrontDraftsPhrase,
} from '@forge/contracts/verdict-identity';

/**
 * What a verdict names as the thing it was judged against, with what coverage checks it by: a design
 * or contract carries the revision or version the traced requirement's latest baseline pins for it
 * (null where that baseline pins none), the anchor both sides built against.
 */
export type CoverageIdentity =
  | { kind: 'commit'; sha: string }
  | { kind: 'commit_unresolved'; sha: string }
  | { kind: 'runtime'; ref: string }
  | { kind: 'design'; workflow: string; revision: number; pinned: number | null }
  | { kind: 'contract'; ref: string; version: string; pinned: string | null }
  | { kind: 'storefront_draft'; drafts: readonly StorefrontDraftPart[]; environment: string };

/**
 * What the live build holds of the verdict commits asked about (`dependents.ts:liveBuildHolds`):
 * the commit production serves (null where it could not be read), per verdict commit (lower case)
 * whether it is that commit or an ancestor of it, or why nobody could answer that, and per runtime
 * ref (lower case) the commit that build served, or null where nothing resolves it. A commit absent
 * from `holds` was not checked and does not count, `unanswered` naming why; a runtime absent from
 * `runtimes` was not resolved and does not count.
 */
export interface LiveBuildHolds {
  sha: string | null;
  holds: ReadonlyMap<string, boolean>;
  runtimes: ReadonlyMap<string, string | null>;
  unanswered: ReadonlyMap<string, string>;
  /**
   * On a project with no production environment (`release-batch/landed-build.ts:landedBuildHolds`),
   * per issue id the landed build its verdicts count on, or why it has none. Present, it replaces the
   * live build for every commit and runtime verdict.
   */
  landed?: ReadonlyMap<string, LandedHolds>;
  /**
   * Beside `landed`, the project's testing environment (`delivery.judgedOn`, REQ-36 BC-18): a runtime
   * verdict at a whole commit is weighed at its landing as a commit verdict is. Null or absent, it
   * names no landed commit.
   */
  judgedOn?: string | null;
}

/** One issue's landed build, or why it has none. */
export interface LandedHolds {
  sha: string | null;
  why: string | null;
  /** Where the build is a host merge commit: the merged request's head and whether its tree is the build's. */
  head?: MergedHead | null;
}

export const short = (sha: string) => sha.slice(0, 12);

/** What the identity names, as the record door spells it (`issues/criteria-verdicts.ts`). */
function identityValue(identity: CoverageIdentity): string {
  switch (identity.kind) {
    case 'commit':
    case 'commit_unresolved':
      return identity.sha;
    case 'runtime':
      return identity.ref;
    case 'design':
      return `${identity.workflow} rev ${identity.revision}`;
    case 'contract':
      return `${identity.ref}@${identity.version}`;
    case 'storefront_draft':
      return `${storefrontDraftsPhrase(identity.drafts)} on ${identity.environment}`;
  }
}

/** The identity in the words a reader sees beside the verdict. */
export function identityWords(identity: CoverageIdentity | null): string | null {
  if (!identity) return null;
  switch (identity.kind) {
    case 'commit':
      return `commit ${short(identity.sha)}`;
    case 'commit_unresolved':
      return `abbreviated commit ${identity.sha}`;
    case 'runtime':
      return `runtime ${short(identity.ref)}`;
    case 'design':
      return `design ${identity.workflow} rev ${identity.revision}`;
    case 'contract':
      return `contract ${identity.ref}@${identity.version}`;
    case 'storefront_draft':
      return `storefront draft ${storefrontDraftsPhrase(identity.drafts)} on ${identity.environment}`;
  }
}

/** What a judgement is checked against the live build by, and why it does not count where it cannot be. */
export interface Resolved {
  commit: string | null;
  inLiveBuild: boolean | null;
  notCounted: string | null;
  /** Where it counts on a build other than the commit it names, the words saying on what. */
  countedAs?: string;
}

// Kernel input (`VISION: kernel-hard-policy-soft`): every identity a verdict can name is either
// resolved to something a rule checks or does not count, saying why. A commit and the commit a
// runtime served are held to the live build (`liveBuildHolds`) and count only where it is read to
// hold them: one the live build lacks, and one whose hold nobody could answer (production unread,
// ancestry unanswered), do not count (`VISION: state-never-lies`: an outage reads as unchecked,
// named, never as passing). A design or contract is held to the revision or version the
// requirement's latest baseline pins (requirement-to-delivery `verdict-result`). A storefront draft
// is judged on a non-production environment and a backfilled abbreviation names no whole commit, so
// neither is evidence about the live build.
export function atLiveCommit(
  commit: string,
  judged: string,
  live: LiveBuildHolds | null,
): Resolved {
  const key = commit.toLowerCase();
  const inLiveBuild = live?.holds.get(key) ?? null;
  const build = `the live build${live?.sha ? ` (${short(live.sha)})` : ''}`;
  if (inLiveBuild === true) return { commit, inLiveBuild, notCounted: null };
  if (inLiveBuild === false) {
    return {
      commit,
      inLiveBuild,
      notCounted: `judged at ${judged}, which ${build} does not hold`,
    };
  }
  const why = live
    ? (live.unanswered.get(key) ?? 'nothing answered it')
    : 'the live build was not read';
  return {
    commit,
    inLiveBuild,
    notCounted: `judged at ${judged}, and whether ${build} holds it could not be checked: ${why}`,
  };
}

export function resolve(
  identity: CoverageIdentity | null,
  live: LiveBuildHolds | null,
  issueId: string,
): Resolved {
  const atCommit = (commit: string, judged: string) => atLiveCommit(commit, judged, live);
  const none = (why: string): Resolved => ({ commit: null, inLiveBuild: null, notCounted: why });
  if (!identity) return none('it names nothing it was judged against');
  const landed = live?.landed;
  if (landed) {
    if (identity.kind === 'commit') {
      return atLanding(identity.sha, landed.get(issueId.toLowerCase()) ?? null);
    }
    const why = landedIdentityWhy(identity.kind, identityValue(identity), live?.judgedOn ?? null);
    if (why === null && identity.kind === 'runtime') {
      return atLanding(identity.ref.toLowerCase(), landed.get(issueId.toLowerCase()) ?? null);
    }
    return none(why as string);
  }
  switch (identity.kind) {
    case 'commit':
      return atCommit(identity.sha, `commit ${short(identity.sha)}`);
    case 'runtime': {
      const ref = identity.ref.toLowerCase();
      const served = live?.runtimes.get(ref);
      if (served)
        return atCommit(served, `runtime ${short(ref)}, which served commit ${short(served)}`);
      return none(
        served === null
          ? `runtime ${short(ref)} is not a commit and no release Forge verified served it, so nothing says which build it was`
          : `runtime ${short(ref)} could not be resolved to the build it served`,
      );
    }
    case 'design':
      if (identity.pinned === identity.revision)
        return { commit: null, inLiveBuild: null, notCounted: null };
      return none(
        identity.pinned === null
          ? `judged against design ${identity.workflow} rev ${identity.revision}, which the requirement's latest baseline does not pin`
          : `judged against design ${identity.workflow} rev ${identity.revision}, and the requirement's latest baseline pins rev ${identity.pinned}`,
      );
    case 'contract':
      if (identity.pinned === identity.version)
        return { commit: null, inLiveBuild: null, notCounted: null };
      return none(
        identity.pinned === null
          ? `judged against contract ${identity.ref}@${identity.version}, which the requirement's latest baseline does not pin`
          : `judged against contract ${identity.ref}@${identity.version}, and the requirement's latest baseline pins ${identity.pinned}`,
      );
    case 'storefront_draft':
      return none(
        `judged on storefront draft ${identity.drafts.map((p) => p.workflowId).join(', ')} in ${identity.environment}, a non-production environment, not on the live build`,
      );
    case 'commit_unresolved':
      return none(
        `judged at abbreviated commit ${identity.sha}, a backfilled identity that never resolved to a whole commit`,
      );
  }
}

// With no production environment the build a verdict counts on is its issue's landing
// (`release-batch/landed-build.ts`), and only a verdict at that very commit counts, or at the head of
// the request that merged as it where Forge read from the host, at the merge, that the two trees are
// identical (`issues.merged_head`): a head whose tree differs, or whose tree was not read, judged
// another build as far as anyone can say. One at any other earlier commit judged another build, and
// one at a later head counts once a landing is recorded there, or before any record where every live
// criterion of the issue passes at that one head and it holds the landing
// (`release-batch/landed-build.ts:aheadBuildsOf`).
function atLanding(commit: string, landed: LandedHolds | null): Resolved {
  const judged = `judged at commit ${short(commit)}`;
  if (!landed) {
    return {
      commit,
      inLiveBuild: null,
      notCounted: `${judged}, and its issue's landing was not read`,
    };
  }
  if (landed.sha === null) {
    return { commit, inLiveBuild: null, notCounted: `${judged}, and ${landed.why}` };
  }
  if (commit.toLowerCase() === landed.sha) return { commit, inLiveBuild: true, notCounted: null };
  const head = landed.head;
  if (head && head.sha.toLowerCase() === commit.toLowerCase()) {
    const merged = `the head of the request that landed as ${short(landed.sha)}`;
    if (head.treeIdentical === true) {
      return {
        commit,
        inLiveBuild: true,
        notCounted: null,
        countedAs: `${judged}, tree-identical to landing ${short(landed.sha)}`,
      };
    }
    return {
      commit,
      inLiveBuild: false,
      notCounted:
        head.treeIdentical === false
          ? `${judged}, ${merged}, and the host shows its tree differs from the landing's: judge it again at ${short(landed.sha)}`
          : `${judged}, ${merged}, and whether its tree is the landing's was not read (${head.why ?? 'nothing says why'}): judge it again at ${short(landed.sha)}`,
    };
  }
  return {
    commit,
    inLiveBuild: false,
    notCounted: `${judged}, not at its issue's landing ${short(landed.sha)}: judge it again at ${short(landed.sha)}`,
  };
}
