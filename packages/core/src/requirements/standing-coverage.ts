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

export interface StandingIssueCriterion {
  issueId: string;
  n: number;
  requirementCriterionId: string;
  verdict: CoverageIssue['verdict'];
  verdictAt: Date | null;
  /** The commit the verdict was judged at; null where it names none. */
  commit: string | null;
}

/**
 * What the live build holds of the verdict commits asked about (`dependents.ts:liveBuildHolds`):
 * the commit production serves, and per verdict commit (lower case) whether it is that commit or an
 * ancestor of it. A commit absent from `holds` was not answered and is not judged either way.
 */
export interface LiveBuildHolds {
  sha: string;
  holds: ReadonlyMap<string, boolean>;
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

// A business criterion is proven by the issue criteria that trace to it
// (issue_criteria.requirement_criterion_id, ISS-55). Only links to the wording live at the shown
// revision count as proof; a link to an earlier wording of the same code is stale evidence. Over
// the live links the newest judgement decides (requirement-lifecycle `delivered`): of the latest
// verdicts that are a pass, short or fail, the one recorded last counts — a pass or short →
// passing, a fail → failing — so a link nobody judged, or judged could-not-judge, masks nothing and
// an old fail stands only while it is the newest. A verdict at a commit the live build is read not to
// hold is evidence about another build: it never counts. None counts → not judged, or stale where
// the only judgements were on another build. No live link but an earlier one → stale; no link at
// all → gap, carrying the reason an accepted breakdown gave for leaving it uncovered. A dropped
// issue proves nothing and is left out.
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
  const held = (commit: string | null) =>
    commit === null ? null : (input.liveBuild?.holds.get(commit.toLowerCase()) ?? null);
  return live.map((bc) => {
    const links = input.issueCriteria.flatMap((ic) => {
      const wording = byId.get(ic.requirementCriterionId);
      const issue = issues.get(ic.issueId);
      if (!wording || wording.code !== bc.code || !issue) return [];
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
          commit: ic.verdict === null ? null : ic.commit,
          inLiveBuild: ic.verdict === null ? null : held(ic.commit),
          stale: wording.id !== bc.id,
        } satisfies CoverageIssue,
      ];
    });
    const counts = countedOf(links);
    const verdict = verdictOf(links, counts);
    const why = verdict === 'gap' ? (input.uncovered?.get(bc.code) ?? null) : null;
    return { code: bc.code, body: bc.body, verdict, issues: links, counts, uncoveredReason: why };
  });
}

const JUDGED: ReadonlySet<CoverageIssue['verdict']> = new Set(['pass', 'short', 'fail']);

/** Of the live links' judgements on a build the live one is not read to lack, the newest. */
function countedOf(links: readonly CoverageIssue[]): CoverageCount | null {
  let newest: CoverageIssue | null = null;
  for (const l of links) {
    if (l.stale || !JUDGED.has(l.verdict) || l.verdictAt === null || l.inLiveBuild === false) {
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
  return otherBuild ? 'stale' : 'not_judged';
}
