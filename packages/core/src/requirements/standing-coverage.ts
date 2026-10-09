/**
 * Each business criterion's coverage by the verdicts on the issue criteria tracing it, read at the
 * shown revision: the one computation `standing.ts:deliveryAt` hands the standing, the accept and a
 * release's requirement bar. Pure, so every rule below is a unit test (`standing.test.ts`).
 */

import type {
  BcVerdict,
  CoverageCount,
  CoverageIssue,
  RequirementCoverage,
} from '@forge/contracts/requirements';
import { liveAt } from './rules.js';

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
  | { kind: 'storefront_draft'; workflowId: string; draftVersion: string; environment: string };

export interface StandingIssueCriterion {
  issueId: string;
  n: number;
  requirementCriterionId: string;
  verdict: CoverageIssue['verdict'];
  verdictAt: Date | null;
  /** What the verdict was judged against; null where there is no verdict or it names nothing. */
  identity: CoverageIdentity | null;
}

/**
 * What the live build holds of the verdict commits asked about (`dependents.ts:liveBuildHolds`):
 * the commit production serves (null where it could not be read), per verdict commit (lower case)
 * whether it is that commit or an ancestor of it, and per runtime ref (lower case) the commit that
 * build served, or null where nothing resolves it. A commit absent from `holds` was not answered and
 * is judged neither way; a runtime absent from `runtimes` was not resolved and does not count.
 */
export interface LiveBuildHolds {
  sha: string | null;
  holds: ReadonlyMap<string, boolean>;
  runtimes: ReadonlyMap<string, string | null>;
}

/** What coverage reads: the requirement's wordings, its issues, their traced criteria and verdicts. */
interface CoverageInput {
  criteria: readonly {
    id: string;
    code: string;
    body: string;
    sinceRevision: number;
    retiredRevision: number | null;
  }[];
  issues: readonly (Pick<CoverageIssue, 'displayId' | 'title' | 'status' | 'tone'> & {
    id: string;
  })[];
  issueCriteria: readonly StandingIssueCriterion[];
  /** Per BC code, why the newest accepted breakdown naming it left it uncovered. */
  uncovered?: ReadonlyMap<string, string> | undefined;
  /** What the live build holds of the verdict commits; null or absent where it was not read. */
  liveBuild?: LiveBuildHolds | null | undefined;
}

const short = (sha: string) => sha.slice(0, 12);

/** The identity in the words a reader sees beside the verdict. */
function identityWords(identity: CoverageIdentity | null): string | null {
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
      return `storefront draft ${identity.workflowId}@${short(identity.draftVersion)} on ${identity.environment}`;
  }
}

/** What a judgement is checked against the live build by, and why it does not count where it cannot be. */
interface Resolved {
  commit: string | null;
  inLiveBuild: boolean | null;
  notCounted: string | null;
}

// Kernel input (`VISION: kernel-hard-policy-soft`): every identity a verdict can name is either
// resolved to something a rule checks or does not count, saying why. A commit and the commit a
// runtime served are held to the live build (`liveBuildHolds`); a design or contract to the revision
// or version the requirement's latest baseline pins (requirement-to-delivery `verdict-result`). A
// storefront draft is judged on a non-production environment and a backfilled abbreviation names
// no whole commit, so neither is evidence about the live build.
function resolve(identity: CoverageIdentity | null, live: LiveBuildHolds | null): Resolved {
  const held = (commit: string) => live?.holds.get(commit.toLowerCase()) ?? null;
  const atCommit = (commit: string, judged: string): Resolved => {
    const inLiveBuild = held(commit);
    return {
      commit,
      inLiveBuild,
      notCounted:
        inLiveBuild === false
          ? `judged at ${judged}, which the live build${live?.sha ? ` (${short(live.sha)})` : ''} does not hold`
          : null,
    };
  };
  const none = (why: string): Resolved => ({ commit: null, inLiveBuild: null, notCounted: why });
  if (!identity) return none('it names nothing it was judged against');
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
        `judged on storefront draft ${identity.workflowId} in ${identity.environment}, a non-production environment, not on the live build`,
      );
    case 'commit_unresolved':
      return none(
        `judged at abbreviated commit ${identity.sha}, a backfilled identity that never resolved to a whole commit`,
      );
  }
}

// A business criterion is proven by the issue criteria that trace to it
// (issue_criteria.requirement_criterion_id, ISS-55). Only links to the wording live at the shown
// revision count as proof; a link to an earlier wording of the same code is stale evidence. Over
// the live links the newest judgement that counts decides (requirement-lifecycle `delivered`): of the
// latest verdicts that are a pass, short or fail, the one recorded last counts — a pass or short →
// passing, a fail → failing — so a link nobody judged, or judged could-not-judge, masks nothing and
// an old fail stands only while it is the newest. A judgement counts only where its identity resolves
// to something checked (`resolve`): one that does not is named on its line and never counts. None
// counts → not live where a judgement sits on a build the live one does not hold, else not judged.
// No live link but an earlier one → stale; no link at all → gap, carrying the reason an accepted
// breakdown gave for leaving it uncovered. A dropped issue proves nothing and is left out.
export function coverageOf(
  input: CoverageInput,
  shownRevision: number | null,
): RequirementCoverage[] {
  if (shownRevision === null) return [];
  const live = liveAt(input.criteria, shownRevision);
  const byId = new Map(input.criteria.map((c) => [c.id, c]));
  const issues = new Map(
    input.issues.filter((i) => i.status !== 'dropped').map((i) => [i.id, i] as const),
  );
  return live.map((bc) => {
    const links = input.issueCriteria.flatMap((ic) => {
      const wording = byId.get(ic.requirementCriterionId);
      const issue = issues.get(ic.issueId);
      if (!wording || wording.code !== bc.code || !issue) return [];
      const judged = JUDGED.has(ic.verdict);
      const r = ic.verdict === null ? null : resolve(ic.identity, input.liveBuild ?? null);
      return [
        {
          issueId: issue.id,
          displayId: issue.displayId,
          title: issue.title,
          status: issue.status,
          tone: issue.tone,
          criterion: ic.n,
          verdict: ic.verdict,
          verdictAt: ic.verdictAt?.toISOString() ?? null,
          identity: ic.verdict === null ? null : identityWords(ic.identity),
          commit: r?.commit ?? null,
          inLiveBuild: r?.inLiveBuild ?? null,
          notCounted: judged ? (r?.notCounted ?? null) : null,
          stale: wording.id !== bc.id,
        } satisfies CoverageIssue,
      ];
    });
    const counts = countedOf(links);
    const verdict = verdictOf(links, counts);
    const why = whyOf(verdict, links);
    const uncovered = verdict === 'gap' ? (input.uncovered?.get(bc.code) ?? null) : null;
    return {
      code: bc.code,
      body: bc.body,
      verdict,
      issues: links,
      counts,
      why,
      uncoveredReason: uncovered,
    };
  });
}

const JUDGED: ReadonlySet<CoverageIssue['verdict']> = new Set(['pass', 'short', 'fail']);

/** Of the live links' judgements that count, the newest. */
function countedOf(links: readonly CoverageIssue[]): CoverageCount | null {
  let newest: CoverageIssue | null = null;
  for (const l of links) {
    if (l.stale || !JUDGED.has(l.verdict) || l.verdictAt === null || l.notCounted !== null) {
      continue;
    }
    if (!newest || (newest.verdictAt as string) < l.verdictAt) newest = l;
  }
  if (!newest) return null;
  return {
    issueId: newest.issueId,
    displayId: newest.displayId,
    criterion: newest.criterion,
    verdict: newest.verdict as CoverageCount['verdict'],
    at: newest.verdictAt as string,
    identity: newest.identity as string,
    commit: newest.commit,
    inLiveBuild: newest.inLiveBuild,
  };
}

function verdictOf(links: readonly CoverageIssue[], counts: CoverageCount | null): BcVerdict {
  if (links.length === 0) return 'gap';
  const current = links.filter((l) => !l.stale);
  if (current.length === 0) return 'stale';
  if (counts) return counts.verdict === 'fail' ? 'failing' : 'passing';
  const otherBuild = current.some((l) => JUDGED.has(l.verdict) && l.inLiveBuild === false);
  return otherBuild ? 'not_live' : 'not_judged';
}

/** The criterion's state in one sentence, where no verdict counts and something says why. */
function whyOf(verdict: BcVerdict, links: readonly CoverageIssue[]): string | null {
  const keys = (ls: readonly CoverageIssue[]) =>
    [...new Set(ls.map((l) => l.displayId))].join(', ');
  if (verdict === 'stale') {
    return `${keys(links)} trace only an earlier wording of this criterion, so no verdict on them counts: tie it again from the issue's Criteria tab, then judge it`;
  }
  const uncounted = links.filter((l) => !l.stale && l.notCounted !== null);
  if (verdict === 'not_live') {
    const off = uncounted.filter((l) => l.inLiveBuild === false);
    return `judged only at builds the live one does not hold (${off.map((l) => `${l.displayId} criterion ${l.criterion}: ${l.identity}`).join('; ')}): judge it again on the live build`;
  }
  if (verdict === 'not_judged' && uncounted.length > 0) {
    return `no verdict counts yet: ${uncounted.map((l) => `${l.displayId} criterion ${l.criterion}: ${l.notCounted}`).join('; ')}`;
  }
  return null;
}
