/**
 * What a verdict names as the thing it was judged against, and whether coverage can count it there:
 * the live build's hold on a commit or a runtime, a project's landed build where it has no production
 * environment, the pinned design revision or contract version (`standing-coverage.ts:coverageOf`).
 * Pure, so every rule below is a unit test (`standing-coverage.test.ts`).
 */

import type { MergedHead } from '@forge/contracts/landing-artifacts';
import {
  type ReleasedLine,
  readOnRelease,
  releaseHoldsIssue,
  releaseNotHoldingWhy,
} from '@forge/contracts/released-line';
import {
  landedCommitOf,
  type StorefrontDraftPart,
  storefrontDraftsPhrase,
} from '@forge/contracts/verdict-identity';
import { type Carriage, carriedToLanding } from '../issues/index.js';

export type { ReleasedLine } from '@forge/contracts/released-line';

/**
 * What a verdict names as the thing it was judged against, with what coverage checks it by: a design
 * or contract carries the revision or version the traced requirement's latest baseline pins for it
 * (null where that baseline pins none), the anchor both sides built against.
 */
export type CoverageIdentity =
  | { kind: 'commit'; sha: string }
  | { kind: 'commit_unresolved'; sha: string }
  | { kind: 'runtime'; ref: string }
  | { kind: 'release'; version: string }
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
   * Where the release weighs an issue's criteria at its landing
   * (`release-batch/criteria-basis.ts:coverageLandingHolds`): a project with no production
   * environment, or one whose production a promotion reaches. Per issue id the landed build its
   * verdicts count on, or why it has none. Present, it replaces the live build for every commit and
   * runtime verdict on an issue.
   */
  landed?: ReadonlyMap<string, LandedHolds>;
  /**
   * Beside `landed`, set where a promotion reaches production (ISS-849): only the issues' verdicts
   * count at their landings, and the requirement's own are judged on the live build (`sha`, `holds`)
   * as on any project with production, never on a recorded landing.
   */
  promoted?: boolean;
  /**
   * Beside `promoted`, set where production names no commit it serves and no promotion stands
   * between (ISS-957): the requirement's own verdicts count only on a recorded release.
   */
  byRecord?: boolean;
  /**
   * Beside `landed`, the project's testing environment (`delivery.judgedOn`, REQ-36 BC-18): a runtime
   * verdict at a whole commit is weighed at its landing as a commit verdict is. Null or absent, it
   * names no landed commit.
   */
  judgedOn?: string | null;
  /**
   * Beside `landed`, the landings Forge recorded at the commits the requirement's own verdicts name
   * and of its issues (`recorded-landings.ts:recordedLandingsOf`); absent where none was read.
   */
  recordedLandings?: RecordedLandings;
  /**
   * Where the project's production names no commit it serves (no source probe: its releases are its
   * agent's record by version, ISS-900), what that record says is live
   * (`release-batch/released-line.ts:releasedLineOf`): a verdict naming a release is weighed there,
   * and a commit is never matched. Absent on any other project.
   */
  released?: ReleasedLine;
  /**
   * Where the release weighs an issue's criteria at what is served (no `landed`), each issue's landing
   * as the landing weighing reads it (`release-batch/criteria-basis.ts:servedLandingHolds`), asked
   * only for the issues holding a commit or runtime verdict the live build does not hold. A verdict the
   * live build does not hold still counts where it carries its issue's landing (ISS-1018: sidcorp-mail
   * ISS-8's control runs a build of the working branch holding its landing, outside the lineage
   * production serves). Absent where nothing was asked.
   */
  landings?: ReadonlyMap<string, LandedHolds>;
  /**
   * Per issue id (lower case) of another project delivering the requirement, what that project's own
   * build holds of its verdicts: a sibling project ships on its own build, so its issue's verdicts are
   * weighed there and never on the requirement project's (`holdsFor`). Null where nothing was asked.
   */
  foreign?: ReadonlyMap<string, LiveBuildHolds | null>;
}

/** The build an issue's verdicts are weighed on: its own project's where it is another project's issue. */
export function holdsFor(live: LiveBuildHolds | null, issueId: string): LiveBuildHolds | null {
  const key = issueId.toLowerCase();
  return live?.foreign?.has(key) ? (live.foreign.get(key) ?? null) : live;
}

/**
 * The release record a judgement is asked on (ISS-900), one rule for every ask and hint: the project's
 * where its production names no commit it serves, since a verdict on its live release counts there,
 * at a promotion's landing too (`release-batch/landed-weighing.ts`); on a promotion project with no
 * release recorded yet, null, since a commit judged at the landing counts there and a release cannot.
 * Where the landing basis is the release record itself (`byRecord`, ISS-957), the record is asked for.
 */
export function askedOnRelease(live: LiveBuildHolds | null | undefined): ReleasedLine | null {
  const line = live?.released;
  if (!line) return null;
  return line.live || !live?.landed || live.byRecord ? line : null;
}

/** A landing Forge recorded: the issue whose merge mark names it, its commit, time and target branch. */
export interface RecordedLanding {
  issueKey: string;
  sha: string;
  at: Date;
  target: string | null;
}

/** Per commit (lower case) the latest landing recorded at it, and per issue id (lower case) its own or null. */
export interface RecordedLandings {
  named: ReadonlyMap<string, RecordedLanding>;
  issues: ReadonlyMap<string, RecordedLanding | null>;
}

/** One issue's landed build, or why it has none. */
export interface LandedHolds {
  sha: string | null;
  why: string | null;
  /** Where the build is a host merge commit: the merged request's head and whether its tree is the build's. */
  head?: MergedHead | null;
  /**
   * Per later commit a verdict on the issue names (lower case), whether it holds the landing, or the
   * record that is missing, from the landings Forge recorded (`release-batch/recorded-holding.ts`).
   * A commit absent was not asked, and is read as another build.
   */
  holders?: ReadonlyMap<string, boolean | { unread: string }>;
  /**
   * Per other commit a verdict on the issue names (lower case), what the landing holds of it, from
   * the landings Forge recorded (`release-batch/landed-build-holds.ts:earlierCarriageOf`): a pass at
   * one it descends from is carried to it (ISS-845). A commit absent was not asked.
   */
  descent?: ReadonlyMap<string, Carriage>;
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
    case 'release':
      return identity.version;
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
    case 'release':
      return `release ${identity.version}`;
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
  /** The path prefixes the verdict covers, which a carriage to a later landing is held to (ISS-845). */
  covers: readonly string[] | null = null,
): Resolved {
  const atCommit = (commit: string, judged: string) => atLiveCommit(commit, judged, live);
  const none = (why: string): Resolved => ({ commit: null, inLiveBuild: null, notCounted: why });
  if (!identity) return none('it names nothing it was judged against');
  // a release is placed on its agent's record wherever the project's issues are weighed (ISS-900)
  if (identity.kind === 'release') return atRelease(identity.version, live?.released);
  const landed = live?.landed;
  if (landed) {
    // the record door's reading of the commit a verdict names (contracts `landedCommitOf`)
    const named = landedCommitOf(identity.kind, identityValue(identity), live?.judgedOn ?? null);
    if ('why' in named) return none(named.why);
    return atLanding(named.sha, landed.get(issueId.toLowerCase()) ?? null, covers);
  }
  // a commit, or the commit a runtime served, the live build does not hold is weighed at its issue's landing
  const orLanded = (r: Resolved, commit: string) =>
    orAtLanding(r, commit, live?.landings, issueId, covers);
  switch (identity.kind) {
    case 'commit':
      return orLanded(atCommit(identity.sha, `commit ${short(identity.sha)}`), identity.sha);
    case 'runtime': {
      const ref = identity.ref.toLowerCase();
      const served = live?.runtimes.get(ref);
      if (served)
        return orLanded(
          atCommit(served, `runtime ${short(ref)}, which served commit ${short(served)}`),
          served,
        );
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

// Where the release weighs at what is served, a verdict counts on the live build, and where the live
// build does not hold it, or nobody could say, at its issue's landing by the one weighing the release
// and the issue's own read give a landing (`atLanding`, ISS-1018): a component deployed outside the
// release, as sidcorp-mail's control is (mta1 runs a2fb071, a build of the working branch holding
// ISS-8's landing 286764e, never under what production serves), is judged on a build that carries the
// work, and its verdicts read "not judged" for ever otherwise. Neither counting, the reason names both
// readings and the identities that would count: the live build, the landing, or a later build a
// landing Forge recorded places after it (`VISION: state-never-lies`).
function orAtLanding(
  live: Resolved,
  commit: string,
  landings: ReadonlyMap<string, LandedHolds> | undefined,
  issueId: string,
  covers: readonly string[] | null,
): Resolved {
  if (live.notCounted === null || !landings) return live;
  const landed = landings.get(issueId.toLowerCase()) ?? null;
  const at = atLanding(commit, landed, covers);
  if (at.notCounted === null) {
    return {
      ...at,
      countedAs: at.countedAs ?? `judged at commit ${short(commit)}, its issue's landing`,
    };
  }
  const instead = landed?.sha
    ? `: judge it again on the live build or at ${short(landed.sha)}, its issue's landing, or at a later build a landing Forge recorded places after it`
    : '';
  return {
    ...live,
    notCounted: `${live.notCounted}; nor does it count at its issue's landing: ${at.notCounted}${instead}`,
  };
}

// With no production environment the build a verdict counts on is its issue's landing
// (`release-batch/landed-build.ts`): a verdict counts at that very commit, at the head of the request
// that merged as it where Forge read from the host, at the merge, that the two trees are identical
// (`issues.merged_head`), at a later build that holds the landing (`LandedHolds.holders`, REQ-36
// BC-18): the testing environment serves such a build, and `judged-build.ts` sends the judge to it
// (adminhub-fe ISS-4), or at an earlier one the landing descends from, carried to it unless what it
// covers changed (`LandedHolds.descent`, ISS-845): the one rule the release hold weighs an issue's
// landing by (`issues/landed-carriage.ts:carriedToLanding`, read in the same order as
// `release-batch/landed-weighing.ts:weighOnLanded`). A head whose tree differs or was not read, and a commit that does not hold
// the landing, judged another build as far as anyone can say; one whose hold was not read is
// unchecked, never passing (`VISION: state-never-lies`). A release record keeps its own rule: the
// recorded commit must hold the verdict's (`release-batch/landing-coverage.ts`).
function atLanding(
  commit: string,
  landed: LandedHolds | null,
  covers: readonly string[] | null,
): Resolved {
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
  const away = `${judged}, not at its issue's landing ${short(landed.sha)}`;
  const descends = landed.descent?.get(commit.toLowerCase());
  const carried = carriedToLanding(landed.sha, commit.toLowerCase(), covers, descends);
  if (carried?.kind === 'carried') {
    return {
      commit,
      inLiveBuild: true,
      notCounted: null,
      countedAs: `${judged}, ${carried.words}`,
    };
  }
  const held = landed.holders?.get(commit.toLowerCase());
  if (held === true) {
    return {
      commit,
      inLiveBuild: true,
      notCounted: null,
      countedAs: `${judged}, which holds landing ${short(landed.sha)}`,
    };
  }
  if (carried && (carried.kind === 'refused' || held === undefined || held === false)) {
    // another build where the landing does not descend from it; where it does, what it covers
    // changed or went unread, and nothing says the criterion holds there
    const another = carried.kind === 'refused' && descends?.kind !== 'descends';
    return { commit, inLiveBuild: another ? false : null, notCounted: carried.why };
  }
  if (held === false) {
    return {
      commit,
      inLiveBuild: false,
      notCounted: `${away} nor at a build that holds it: judge it again at ${short(landed.sha)} or at a later build that holds it`,
    };
  }
  if (held !== undefined) {
    return {
      commit,
      inLiveBuild: null,
      notCounted: `${away}, and no record of Forge's says it holds that landing: ${held.unread}${
        descends?.kind === 'unread'
          ? `; nor was it read that \`${short(landed.sha)}\` descends from it: ${descends.why}`
          : ''
      }`,
    };
  }
  return {
    commit,
    inLiveBuild: false,
    notCounted: `${away}: judge it again at ${short(landed.sha)}`,
  };
}

/**
 * A verdict recorded at a requirement on a project with no production environment, at `commit`
 * (catalog-fe REQ-7 BC-2, 2026-10-30: a pass at the served dev build read not judged for ever). It
 * counts where the commit is a landing Forge recorded, on the branch every traced issue landed on, at
 * or after each of their landings: a build Forge itself recorded reaching the judged environment
 * with all of that work behind it. Nothing is inferred from a host; where a record is missing, the
 * reason names it.
 */
export function atRecordedLanding(
  commit: string,
  traced: readonly string[],
  recorded: RecordedLandings | undefined,
): Resolved {
  const judged = `judged at commit ${short(commit)}`;
  const refused = (why: string): Resolved => ({
    commit,
    inLiveBuild: null,
    notCounted: `${judged}, ${why}`,
  });
  if (!recorded) return refused('and no landing Forge recorded was read to place it');
  const at = recorded.named.get(commit.toLowerCase());
  if (!at) {
    return refused(
      "which no landing Forge recorded on this project names (no issue's merge mark is at it), so no record says the judged environment served it",
    );
  }
  const where = `${at.issueKey}'s landing on \`${at.target ?? 'no recorded branch'}\` at ${at.at.toISOString()}`;
  for (const id of traced) {
    const own = recorded.issues.get(id.toLowerCase()) ?? null;
    if (!own) return refused(`${where}, and a traced issue records no landing of its own`);
    if (own.target !== at.target) {
      return refused(
        `${where}, and ${own.issueKey} landed on \`${own.target ?? 'no recorded branch'}\`, another branch`,
      );
    }
    if (own.at > at.at) {
      return refused(`${where}, before ${own.issueKey}'s landing at ${own.at.toISOString()}`);
    }
  }
  return { commit, inLiveBuild: null, notCounted: null };
}

/**
 * A verdict judged on release `version` (ISS-900), on a project whose production names no commit it
 * serves: the one rule every door reads (`@forge/contracts/released-line:readOnRelease`). Nothing reads
 * production and no commit is matched.
 */
export function atRelease(version: string, line: ReleasedLine | undefined): Resolved {
  return { commit: null, ...readOnRelease(version, line) };
}

/**
 * An issue criterion's verdict as the release weighs it at the issue's landing
 * (`release-batch/landed-weighing.ts`, ISS-957), where its project's production names no commit it
 * serves: a pass on a release counts only where that release's record holds the issue, and a
 * criterion only the running product shows (`liveOnly`, classed `observable`) counts only on such a
 * release, never at a build. Anywhere else, `resolve`.
 */
export function resolveIssueVerdict(
  identity: CoverageIdentity | null,
  live: LiveBuildHolds | null,
  issueId: string,
  covers: readonly string[] | null,
  liveOnly: boolean,
): Resolved {
  const line = live?.released;
  if (line && identity?.kind === 'release') {
    const read = atRelease(identity.version, line);
    if (read.notCounted !== null || releaseHoldsIssue(line, identity.version, issueId) !== false) {
      return read;
    }
    return {
      commit: null,
      inLiveBuild: false,
      notCounted: releaseNotHoldingWhy(line, identity.version, issueId),
    };
  }
  if (line && liveOnly && identity) {
    const r = resolve(identity, live, issueId, covers);
    return {
      ...r,
      inLiveBuild: r.commit === null ? r.inLiveBuild : false,
      notCounted:
        'judged at a build, and only the running product shows this criterion, so it counts on a shipped release that holds the issue',
    };
  }
  return resolve(identity, live, issueId, covers);
}
