/**
 * Each business criterion's coverage by the verdicts on the issue criteria tracing it and by those
 * recorded on the criterion itself (ISS-588), read at the shown revision: the one computation
 * `standing.ts:deliveryAt` hands the standing, the accept and a release's requirement bar. Pure, so
 * every rule below is a unit test (`standing.test.ts`, `standing-shipped.test.ts`).
 */

import type {
  BcVerdict,
  CoverageCount,
  CoverageFile,
  CoverageIssue,
  CoverageRequirementVerdict,
  RequirementCoverage,
} from '@forge/contracts/requirements';
import { landedCommitOf, verdictExercised } from '@forge/contracts/verdict-identity';
import type { VerifiedJudge } from '@forge/contracts/verified-rule';
import { judgesVerdict, unverifiedWhy } from '@forge/contracts/verified-rule';
import { liveAt } from './rules.js';
import {
  atLiveCommit,
  atRecordedLanding,
  type CoverageIdentity,
  holdsFor,
  identityWords,
  type LandedHolds,
  type LiveBuildHolds,
  type Resolved,
  resolve,
  short,
} from './standing-identity.js';

export type { CoverageIdentity, LandedHolds, LiveBuildHolds } from './standing-identity.js';

/** One verdict on an issue criterion, as coverage reads it. */
export interface StandingVerdict {
  verdict: CoverageIssue['verdict'];
  verdictAt: Date | null;
  /** The verdict's own note; absent reads as none written. */
  note?: string | null;
  /** The files the verdict's evidence names that the issue keeps; absent reads as none. */
  files?: readonly CoverageFile[];
  /** What the verdict was judged against; null where there is no verdict or it names nothing. */
  identity: CoverageIdentity | null;
  /** Whether the verdict was recorded by the issue's builder (`issues/built-by.ts`); false where there is none. */
  byBuilder: boolean;
  /** Whether the verdict names who recorded it, an account or a box; false where there is none. */
  authored: boolean;
  /** When it was recorded, as the verified rule reads it; null where there is none. */
  recordedAt: Date | null;
  /** The path prefixes the verdict covers (ISS-845); absent or null where it names none. */
  covers?: readonly string[] | null;
}

/** An issue criterion tracing a business criterion, read at its latest verdict. */
export interface StandingIssueCriterion extends StandingVerdict {
  issueId: string;
  n: number;
  requirementCriterionId: string;
  /** Its earlier verdicts since the issue's latest reopen, newest first; absent reads as none. */
  earlier?: readonly StandingVerdict[];
  /** Its newest verdict where the issue's latest reopen voided it; absent where none was voided. */
  beforeReopen?: StandingVerdict;
}

/**
 * One verdict recorded on a business criterion at the requirement itself
 * (`requirement_criterion_verdicts`): the proof of a capability that already shipped, which no issue
 * carries. Its wording is the one it judged, so a reworded criterion's verdicts read stale.
 */
export interface StandingRequirementVerdict {
  id: string;
  requirementCriterionId: string;
  verdict: CoverageRequirementVerdict['verdict'];
  verdictAt: Date;
  note: string | null;
  evidence: readonly string[];
  /** The whole commit it was judged at; null for a skip. */
  commit: string | null;
  /** Whether it names who recorded it, an account or a box. */
  authored: boolean;
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
    /** Its project, where it is not the requirement's own; absent reads as the requirement's. */
    otherProject?: CoverageIssue['otherProject'] | undefined;
  })[];
  issueCriteria: readonly StandingIssueCriterion[];
  /** The verdicts recorded on its criteria at the requirement itself; absent reads as none. */
  requirementVerdicts?: readonly StandingRequirementVerdict[] | undefined;
  /** Per BC code, why the newest accepted breakdown naming it left it uncovered. */
  uncovered?: ReadonlyMap<string, string> | undefined;
  /** What the live build holds of the verdict commits; null or absent where it was not read. */
  liveBuild?: LiveBuildHolds | null | undefined;
  /** Who judges an issue's criteria, the policy's `qa` (`StandingInput.judge`); null where no policy is declared. */
  judge: VerifiedJudge | null;
}

// A business criterion is proven by the issue criteria that trace to it
// (issue_criteria.requirement_criterion_id, ISS-55). Only links to the wording live at the shown
// revision count as proof; a link to an earlier wording of the same code is stale evidence. Over
// the live links the newest judgement that counts decides (requirement-lifecycle `delivered`): of the
// latest verdicts that count, the one recorded last — a pass → passing, a fail → failing — so a link
// nobody judged, or judged could-not-judge, masks nothing and an old fail stands only while it is the
// newest. A judgement counts only where its identity resolves to something checked (`resolve`) and
// it is a verification (contracts `verified-rule.ts:unverifiedWhy`, REQ-35 decision 7b261fca): one that is not is named on its line and never counts.
// None counts → not live where a judgement sits on a build the live one does not hold, else not
// judged. No live link but an earlier one → stale; no link at all → gap, carrying the reason an
// accepted breakdown gave for leaving it uncovered. A dropped issue proves nothing and is left out.
// A verdict recorded on the criterion at the requirement (ISS-588, `requirementVerdictsOn`) is one
// more judgement under the same rule: the newest that counts, from an issue or from it, decides.
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
    const links = input.issueCriteria.flatMap((traced) => {
      const wording = byId.get(traced.requirementCriterionId);
      const issue = issues.get(traced.issueId);
      if (!wording || wording.code !== bc.code || !issue) return [];
      // another project's issue is weighed on its own project's build (`standing-identity.ts:holdsFor`)
      const build = holdsFor(input.liveBuild ?? null, traced.issueId);
      const ic = judgesOf(
        withoutUnplaced(standsAtLanding(traced, build?.landed), build),
        input.judge,
      );
      const judged = verdictExercised(ic.verdict);
      const r =
        ic.verdict === null ? null : resolve(ic.identity, build, traced.issueId, ic.covers ?? null);
      return [
        {
          issueId: issue.id,
          displayId: issue.displayId,
          otherProject: issue.otherProject ?? null,
          title: issue.title,
          status: issue.status,
          tone: issue.tone,
          criterion: traced.n,
          verdict: ic.verdict,
          verdictAt: ic.verdictAt?.toISOString() ?? null,
          note: ic.verdict === null ? null : (ic.note ?? null),
          files: ic.verdict === null ? [] : [...(ic.files ?? [])],
          identity: ic.verdict === null ? null : (r?.countedAs ?? identityWords(ic.identity)),
          commit: r?.commit ?? null,
          inLiveBuild: r?.inLiveBuild ?? null,
          notCounted: judged ? (r?.notCounted ?? unverifiedWhy(ic, input.judge)) : null,
          stale: wording.id !== bc.id,
        } satisfies CoverageIssue,
      ];
    });
    const verdicts = requirementVerdictsOn(bc, input, byId);
    const counts = countedOf(links, verdicts);
    const verdict = verdictOf(links, verdicts, counts);
    const why = whyOf(verdict, links, verdicts, input.liveBuild?.landed !== undefined);
    const uncovered = verdict === 'gap' ? (input.uncovered?.get(bc.code) ?? null) : null;
    return {
      code: bc.code,
      body: bc.body,
      verdict,
      issues: links,
      verdicts,
      counts,
      why,
      uncoveredReason: uncovered,
    };
  });
}

// A verdict recorded on the criterion at the requirement (ISS-588) is judged against the running
// build as a commit verdict on an issue is: it counts only where the live build is read to hold its
// commit. A project with no production environment has no running build to hold it (its issues count
// on their own landings), so there it never counts, saying why. Of those on the current wording the
// one it stands on is read as an issue criterion's is (`judgesOf`): the newest a judge recorded; every
// other is kept on the line, naming the one that replaced it. One on an
// earlier wording is stale and never counts for this one.
function requirementVerdictsOn(
  bc: { id: string; code: string },
  input: CoverageInput,
  byId: ReadonlyMap<string, { id: string; code: string }>,
): CoverageRequirementVerdict[] {
  const mine = (input.requirementVerdicts ?? [])
    .filter((v) => byId.get(v.requirementCriterionId)?.code === bc.code)
    .sort((a, b) => b.verdictAt.getTime() - a.verdictAt.getTime());
  const current = mine.filter((v) => v.requirementCriterionId === bc.id);
  const stands = judgesVerdict(
    current.map((v) => ({ ...v, byBuilder: false, recordedAt: v.verdictAt })),
    input.judge,
  );
  const live = input.liveBuild ?? null;
  // the issues whose criteria trace this business criterion, at any wording; a dropped one proves nothing
  const dropped = new Set(input.issues.filter((i) => i.status === 'dropped').map((i) => i.id));
  const traced = [
    ...new Set(
      input.issueCriteria
        .filter(
          (t) => byId.get(t.requirementCriterionId)?.code === bc.code && !dropped.has(t.issueId),
        )
        .map((t) => t.issueId),
    ),
  ];
  return mine.map((v) => {
    const stale = v.requirementCriterionId !== bc.id;
    const judged = verdictExercised(v.verdict);
    const r: Resolved | null =
      !judged || v.commit === null
        ? null
        : live?.landed
          ? atRecordedLanding(v.commit, traced, live.recordedLandings)
          : atLiveCommit(v.commit, `commit ${short(v.commit)}`, live);
    const replaced =
      !stale && stands !== undefined && stands.id !== v.id
        ? `replaced by the newer verdict recorded at ${stands.verdictAt.toISOString()}`
        : null;
    return {
      verdictId: v.id,
      verdict: v.verdict,
      verdictAt: v.verdictAt.toISOString(),
      identity: v.commit === null ? null : `commit ${short(v.commit)}`,
      note: v.note,
      evidence: [...v.evidence],
      commit: r?.commit ?? null,
      inLiveBuild: r?.inLiveBuild ?? null,
      notCounted: judged
        ? (replaced ??
          r?.notCounted ??
          unverifiedWhy({ ...v, byBuilder: false, recordedAt: v.verdictAt }, input.judge))
        : null,
      stale,
    };
  });
}

// With no production environment a commit names the build exactly, so a reopen voids nothing a
// commit check does not: the issue's own door reads a criterion's newest verdict however old
// (`issues/criteria-verdicts.ts:standingOn`), and the record that closed the issue counted it. A
// newest verdict at a commit older than the reopen stands here as it stands there, and the commit
// check decides whether it counts (`standing-identity.ts:atLanding`), naming why where it does not:
// voiding it read the issue's own pass as no verdict at all (adminhub-api ISS-10, 2026-10-26).
function standsAtLanding(
  traced: StandingIssueCriterion,
  landed: ReadonlyMap<string, LandedHolds> | undefined,
): StandingIssueCriterion {
  const kept = traced.beforeReopen;
  if (!landed || !kept || kept.identity?.kind !== 'commit') return traced;
  return { ...traced, ...kept };
}

/**
 * Whether a verdict is a runtime judgement no build Forge holds can be placed under: on a project
 * with no production environment, one that names no commit by the reading the record door weighs a
 * landing with (contracts `landedCommitOf`: a runtime names its whole commit only where the project
 * names the testing environment it is judged on, `delivery.judgedOn`), or where no release Forge
 * verified served that runtime. A fail is everyone's evidence and is never one of these.
 */
function unplaced(v: StandingVerdict, live: LiveBuildHolds | null): boolean {
  if (v.verdict === null || v.verdict === 'fail' || v.identity?.kind !== 'runtime') return false;
  if (live?.landed)
    return 'why' in landedCommitOf('runtime', v.identity.ref, live.judgedOn ?? null);
  return live?.runtimes.get(v.identity.ref.toLowerCase()) === null;
}

// A runtime verdict nothing places on a build is not a judgement on any build Forge holds, so it never
// hides an older verdict that counts: adminhub-fe ISS-36's judge passed every criterion at its landing
// d2dd9863, and the steward's follow-through then recorded a runtime pass on a project with no
// production environment, which, read as the newest, left REQ-3 with no passing criterion. Such
// verdicts are set aside before the verdict it stands on is read; where nothing else was recorded,
// they stand and say why they do not count.
function withoutUnplaced(
  traced: StandingIssueCriterion,
  live: LiveBuildHolds | null,
): StandingIssueCriterion {
  const all = [traced, ...(traced.earlier ?? [])];
  const kept = all.filter((v) => !unplaced(v, live));
  const [head, ...rest] = kept;
  if (!head || kept.length === all.length) return traced;
  return { ...traced, ...pickVerdict(head), earlier: rest };
}

/** A verdict's own fields, without the issue criterion's. */
function pickVerdict(v: StandingVerdict): StandingVerdict {
  return {
    verdict: v.verdict,
    verdictAt: v.verdictAt,
    note: v.note ?? null,
    files: v.files ?? [],
    identity: v.identity,
    byBuilder: v.byBuilder,
    authored: v.authored,
    recordedAt: v.recordedAt,
    covers: v.covers ?? null,
  };
}

// The verdict an issue criterion stands on. A newer verdict that is not a judge's does not take a
// judge's older one away: the builder's own pass or short after a judge's pass leaves that pass
// standing, whatever the project's `qa` (REQ-74 BC-2). With nothing of a judge's to read, it is the
// latest. A fail is everyone's, so it is never read past, and a skip or short by a judge stands as
// that judge's latest word.
function judgesOf(ic: StandingIssueCriterion, judge: VerifiedJudge | null): StandingVerdict {
  return judgesVerdict<StandingVerdict>([ic, ...(ic.earlier ?? [])], judge) ?? ic;
}

/** Whether a judgement on an issue criterion or at the requirement counts toward its criterion. */
const counted = (l: {
  stale: boolean;
  verdict: CoverageIssue['verdict'];
  verdictAt: string | null;
  notCounted: string | null;
}) => !l.stale && verdictExercised(l.verdict) && l.verdictAt !== null && l.notCounted === null;

/** Of the live links' and the requirement's own judgements that count, the newest. */
function countedOf(
  links: readonly CoverageIssue[],
  verdicts: readonly CoverageRequirementVerdict[],
): CoverageCount | null {
  const issue = links
    .filter(counted)
    .reduce<CoverageIssue | null>(
      (m, l) => (!m || (m.verdictAt as string) < (l.verdictAt as string) ? l : m),
      null,
    );
  const own = verdicts
    .filter(counted)
    .reduce<CoverageRequirementVerdict | null>(
      (m, v) => (!m || m.verdictAt < v.verdictAt ? v : m),
      null,
    );
  if (own && (!issue || (issue.verdictAt as string) < own.verdictAt)) {
    return {
      source: 'requirement',
      verdictId: own.verdictId,
      verdict: own.verdict as CoverageCount['verdict'],
      at: own.verdictAt,
      identity: own.identity as string,
      commit: own.commit,
      inLiveBuild: own.inLiveBuild,
    };
  }
  if (!issue) return null;
  return {
    source: 'issue',
    issueId: issue.issueId,
    displayId: issue.displayId,
    criterion: issue.criterion,
    verdict: issue.verdict as CoverageCount['verdict'],
    at: issue.verdictAt as string,
    identity: issue.identity as string,
    commit: issue.commit,
    inLiveBuild: issue.inLiveBuild,
  };
}

function verdictOf(
  links: readonly CoverageIssue[],
  verdicts: readonly CoverageRequirementVerdict[],
  counts: CoverageCount | null,
): BcVerdict {
  if (links.length === 0 && verdicts.length === 0) return 'gap';
  const current = [...links, ...verdicts].filter((l) => !l.stale);
  if (current.length === 0) return 'stale';
  if (counts) return counts.verdict === 'fail' ? 'failing' : 'passing';
  const otherBuild = current.some((l) => verdictExercised(l.verdict) && l.inLiveBuild === false);
  return otherBuild ? 'not_live' : 'not_judged';
}

/** One judgement that does not count, as the sentence beside its criterion names it. */
interface Uncounted {
  label: string;
  identity: string | null;
  inLiveBuild: boolean | null;
  notCounted: string;
}

const REQUIREMENT_LABEL = "the requirement's own verdict";

/** The criterion's state in one sentence, where no verdict counts and something says why. */
function whyOf(
  verdict: BcVerdict,
  links: readonly CoverageIssue[],
  verdicts: readonly CoverageRequirementVerdict[],
  landed: boolean,
): string | null {
  const keys = (ls: readonly CoverageIssue[]) =>
    [...new Set(ls.map((l) => l.displayId))].join(', ');
  if (verdict === 'stale') {
    if (links.length === 0) {
      return 'it was judged only on an earlier wording of this criterion, so no verdict counts: judge it again on the running build';
    }
    const one = new Set(links.map((l) => l.displayId)).size === 1;
    return `${keys(links)} ${one ? 'traces' : 'trace'} only an earlier wording of this criterion, so no verdict on ${one ? 'it' : 'them'} counts: tie it again from the issue's Criteria tab, then judge it`;
  }
  const uncounted: Uncounted[] = [
    ...links.flatMap((l) =>
      !l.stale && l.notCounted !== null
        ? [{ ...l, label: `${l.displayId} criterion ${l.criterion}`, notCounted: l.notCounted }]
        : [],
    ),
    ...verdicts.flatMap((v) =>
      !v.stale && v.notCounted !== null
        ? [{ ...v, label: REQUIREMENT_LABEL, notCounted: v.notCounted }]
        : [],
    ),
  ];
  const named = (ls: readonly Uncounted[]) =>
    ls.map((l) => `${l.label}: ${l.notCounted}`).join('; ');
  if (verdict === 'not_live') {
    const off = uncounted.filter((l) => l.inLiveBuild === false);
    const rest = uncounted.filter((l) => l.inLiveBuild !== false);
    const also = rest.length > 0 ? `; not counted either: ${named(rest)}` : '';
    const at = off.map((l) => `${l.label}: ${l.identity}`).join('; ');
    if (landed) {
      return `judged only at commits other than their issue's landing and not holding it (${at}): judge it again at the landing or at a later build that holds it${also}`;
    }
    return `judged only at builds the live one does not hold (${at}): judge it again on the live build${also}`;
  }
  if (verdict === 'not_judged' && uncounted.length > 0) {
    return `no verdict counts yet: ${named(uncounted)}`;
  }
  return null;
}
