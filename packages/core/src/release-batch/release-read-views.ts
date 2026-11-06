import type { ReleaseNaming } from '@forge/contracts/release-notes';
import { releaseBuildOf } from '@forge/contracts/release-page';
import {
  type IssueLandingReading,
  RELEASE_ROSTER_LIMIT,
  type ReleaseApprovalView,
  type ReleaseAttemptView,
  type ReleaseContentGroup,
  type ReleaseContinuation,
  type ReleaseCutView,
  type ReleaseDetail,
  type ReleaseDraftApprovalView,
  type ReleaseFeedbackView,
  type ReleaseGateView,
  type ReleaseIssueView,
  type ReleasePerson,
  type ReleaseShippedFailing,
  type ReleaseSplit,
  type ReleaseState,
  type ReleaseSummary,
  type ReleaseTag,
  releaseVerifiedLevel,
} from '@forge/contracts/releases';
import { say } from '@forge/contracts/said';
import { nobodyWaits } from '@forge/contracts/standing';
import type { OwedPolicy } from '@forge/contracts/who-owes';
import type { ReleaseAttemptRow } from '../db/schema-release-ledger.js';
import { reworkedSince } from '../issues/index.js';
import type { ApprovalView } from './approvals.js';
import {
  type ChangeRequestLinkRow,
  changeRequestViews,
  type ReleaseMergeStep,
} from './change-request-roster.js';
import type { RecordedVerification } from './channel.js';
import { type CriterionReading, criterionReadingsAt } from './criterion-reading.js';
import { judgedOnReleaseAt } from './judged-on-release.js';
import { gapOf, releaseChangesOf, surfacesOf } from './landing-surfaces.js';
import type { IssueFact, ReleaseFacts } from './release-facts.js';
import { noteSections } from './release-notes-view.js';
import { irreversibleOf, releaseOwesOf } from './release-owes.js';
import {
  completionOf,
  proofOf,
  sumTotals,
  totalsOf,
  turnOf,
  type ViewerFacts,
} from './release-view.js';

const NOBODY = nobodyWaits(say('releases.rule.issueShipped'));

export interface Part {
  version: string;
  runId: string | null;
  state: ReleaseState;
  issueIds: string[];
  openedAt: Date | null;
  releasedAt: Date | null;
  attempts: ReleaseAttemptRow[];
  approvals: ApprovalView[];
  gates: ReleaseGateView[];
  /** How the run recorded its close is proved; `null` on the draft and on a run that recorded none. */
  verification: RecordedVerification | null;
  /** The commit a finished release's probes verified live (`metadata.finish.commit`); null before. */
  commit: string | null;
  /** Every attempt at this release, first first (`release-cuts.ts`); a draft lists those before it. */
  cuts: ReleaseCutView[];
  /** Where this version's roster went on under another version; null where it is its release's own. */
  continuedAs: ReleaseContinuation | null;
  /** The name and summary written when it was cut (`naming.ts`); null on a draft and until written. */
  naming: ReleaseNaming | null;
  /** The change requests it merges, in its order (REQ-63); null on a release that deploys and on a draft. */
  mergeSteps: ReleaseMergeStep[] | null;
  /** The branch a recorded landing put it on, off production's branch (`versions.ts:landedOffProduction`); else null. */
  landedOn: string | null;
  /** What a recorded landing shipped failing (`metadata.shippedFailing`); null elsewhere. */
  shippedFailing: ReleaseShippedFailing | null;
  /** When a production act went ahead with no person's approval where one was advised (`metadata.unapproved`). */
  unapproved: { at: string } | null;
  /** Its tag on the source host (`release-tag-record.ts`); null on a draft and until its commit is known. */
  tag: ReleaseTag | null;
  /** A listed approver's standing decision on the draft, by its version (`draft-approval.ts`); null elsewhere. */
  draftApproval: ReleaseDraftApprovalView | null;
  /** Whether a decision on this draft is taken (`draft-approval.ts:draftDecisionRefusal`); false on a cut run. */
  draftDecidable: boolean;
}

export interface Shared {
  projectId: string;
  /** The project releases by merging its change requests and its owner deploys, so a release ends at its last merge (REQ-71 BC-6). */
  ownerDeploys: boolean;
  current: string | null;
  required: boolean;
  viewer: ViewerFacts | null;
  approvers: ReleasePerson[];
  /** Who holds project.admin, by name. */
  admins: string[];
  /** The project's policy, which who owes each release's acts is read with (`release-owes.ts`, ISS-1058). */
  policy: OwedPolicy;
  facts: ReleaseFacts;
  /** The project's content language tag, which its release notes are written in. */
  contentLanguage: string;
  /** The production binding's provider as a person reads it, or `null` where none is bound. */
  provider: string | null;
  /** Every change request linked to an issue these releases carry (REQ-63 BC-5). */
  changeRequestLinks: readonly ChangeRequestLinkRow[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** The issues `p` carries whose round it shipped is no longer their current one (`issues/release-evidence.ts:reworkedSince`). */
export function reworkedIn(
  p: Pick<Part, 'issueIds' | 'openedAt' | 'releasedAt'>,
  facts: ReleaseFacts,
): string[] {
  return p.issueIds.filter((id) => {
    const i = facts.issues.get(id);
    return i !== undefined && reworkedSince(p, i);
  });
}

function inFlightStage(attempts: readonly ReleaseAttemptRow[]) {
  return [...attempts].reverse().find((a) => a.settledAt === null)?.stage ?? null;
}

function approvalFacts(p: Part) {
  const latest = p.approvals[0];
  return latest
    ? { decision: latest.decision, requestedBy: latest.requestedBy, reason: latest.reason }
    : null;
}

/** What the release's issues do that cannot be undone, as their notes say it. */
const irreversibleIn = (p: Part, s: Shared): string[] =>
  irreversibleOf(p.issueIds.map((id) => s.facts.issues.get(id)?.releaseNotes));

function turnFor(p: Part, s: Shared, criteria: { proven: number; total: number }) {
  return turnOf({
    state: p.state,
    version: p.version,
    projectId: s.projectId,
    runId: p.runId,
    merges: p.mergeSteps ? p.mergeSteps.length : null,
    landedOn: p.landedOn,
    required: s.required,
    approval: approvalFacts(p),
    approvers: s.approvers,
    admins: s.admins,
    owes: releaseOwesOf(s.policy, irreversibleIn(p, s)),
    viewer: s.viewer,
    gates: p.gates.filter((g) => g.kind === 'blocker'),
    inFlight: inFlightStage(p.attempts),
    testing: s.facts.judgedOn
      ? {
          environment: s.facts.judgedOn,
          judge: s.facts.judge,
          proven: criteria.proven,
          total: criteria.total,
        }
      : null,
  });
}

function ownerOf(p: Part, s: Shared): { owner: ReleasePerson | null; act: string | null } {
  const latest = p.approvals[0];
  if (latest?.decision && latest.decidedBy) {
    return {
      owner: latest.decidedBy,
      act: latest.decision === 'approved' ? 'Approved' : 'Returned',
    };
  }
  if (latest) return { owner: latest.requestedBy, act: 'Asked for approval' };
  const cutter = p.runId ? s.facts.cutters.get(p.runId) : undefined;
  return cutter ? { owner: cutter, act: 'Cut' } : { owner: null, act: null };
}

function lastChange(p: Part, s: Shared): string {
  const times = [
    p.openedAt,
    p.releasedAt,
    ...p.approvals.flatMap((a) => [
      new Date(a.requestedAt),
      a.decidedAt ? new Date(a.decidedAt) : null,
    ]),
    ...p.attempts.flatMap((a) => [a.startedAt, a.settledAt]),
    ...(p.runId === null ? p.issueIds.map((id) => s.facts.issues.get(id)?.updatedAt ?? null) : []),
  ].filter((t): t is Date => t !== null);
  return new Date(Math.max(0, ...times.map((t) => t.getTime()))).toISOString();
}

/** The commit the release was cut at and deploys, as the record names it. */
function headOf(p: Part): string | null {
  return (
    p.commit ??
    p.approvals[0]?.evidence.commit ??
    [...p.attempts].reverse().find((a) => a.commit)?.commit ??
    null
  );
}

/** Each issue's criteria as this release counts them: on its build (`criterionReadingsAt`), which
 *  on a release that merges change requests is the head of the request delivering it. */
function readingsOf(p: Part, s: Shared, issue: IssueFact): CriterionReading[] {
  const head = p.mergeSteps?.find((step) => step.issueIds.includes(issue.id))?.headSha;
  const build = releaseBuildOf(p.state, head ?? headOf(p));
  // when it shipped: a reopen's void holds from the release that ships the fix (`judged-before-reopen.ts`)
  return criterionReadingsAt(issue, build, s.facts, p.version, p.releasedAt);
}

const criteriaOf = (p: Part, s: Shared, issue: IssueFact) =>
  readingsOf(p, s, issue).map((r) => r.view);

/** One issue's criteria as a release weighs them, with the verdicts each was read by. */
export interface WeighedIssue {
  issue: IssueFact;
  /** The requirement it traces, by key; null where it traces none the record carries. */
  requirementKey: string | null;
  readings: CriterionReading[];
}

/**
 * Every criterion a release counts, once: those of the issues it carries, then those judged on a
 * release it counts (`judgedOnReleaseAt`, ISS-900). The header's proof sums these, and the release
 * page lists these (`release-page/claims.ts:claimsOf`), so the two never weigh a criterion apart
 * (ISS-1001: 110/111 at the top of adminhub-api 0.10.0, ISS-25 "9 open" under it).
 */
export function weighedOf(p: Part, s: Shared): WeighedIssue[] {
  const keyOf = (issue: IssueFact) =>
    issue.requirementId ? (s.facts.requirements.get(issue.requirementId)?.key ?? null) : null;
  return [
    ...p.issueIds.flatMap((id) => {
      const issue = s.facts.issues.get(id);
      return issue ? [{ issue, readings: readingsOf(p, s, issue) }] : [];
    }),
    ...judgedOnReleaseAt(s.facts, p.issueIds, p.version),
  ].map((w) => ({ ...w, requirementKey: keyOf(w.issue) }));
}

/** The change request shown beside each issue this release carries. */
function changeRequestsOf(p: Part, s: Shared) {
  const ids = new Set(p.issueIds);
  return changeRequestViews(
    s.changeRequestLinks.filter((l) => ids.has(l.issueId)),
    p.mergeSteps,
  );
}

function contentsOf(p: Part, s: Shared): ReleaseContentGroup[] {
  const groups = new Map<string | null, ReleaseContentGroup>();
  const requests = changeRequestsOf(p, s);
  for (const id of p.issueIds) {
    const issue = s.facts.issues.get(id);
    if (!issue) continue;
    const req = issue.requirementId ? s.facts.requirements.get(issue.requirementId) : undefined;
    const at = req?.key ?? null;
    const group = groups.get(at) ?? {
      requirement: req ? { key: req.key, title: req.title } : null,
      issues: [],
    };
    group.issues.push({
      id,
      key: issue.key,
      title: issue.title,
      status: issue.status,
      proof: proofOf(totalsOf(criteriaOf(p, s, issue))),
      changeRequest: requests.get(id) ?? null,
    });
    groups.set(at, group);
  }
  return [...groups.values()].sort(
    (a, b) => Number(a.requirement === null) - Number(b.requirement === null),
  );
}

const mergedTime = (at: Date | null | undefined) => at?.getTime() ?? Number.POSITIVE_INFINITY;

/**
 * The act RELEASE_ROSTER_OVERSIZE names (`release-gates.ts` OWED): the oldest merged issues, as many
 * as one release carries, cut as this release — offered only where that is the draft's one blocker,
 * since a split leaves every other reason standing on the part it cuts.
 */
function splitOf(p: Part, s: Shared): ReleaseSplit | null {
  const blockers = p.gates.filter((g) => g.kind === 'blocker');
  if (p.state !== 'draft' || s.viewer?.isAdmin !== true) return null;
  if (blockers.length === 0 || blockers.some((g) => g.code !== 'RELEASE_ROSTER_OVERSIZE'))
    return null;
  const oldest = p.issueIds
    .flatMap((id) => s.facts.issues.get(id) ?? [])
    .sort(
      (a, b) =>
        mergedTime(a.merged.at) - mergedTime(b.merged.at) ||
        a.key.localeCompare(b.key, 'en', { numeric: true }),
    )
    .slice(0, RELEASE_ROSTER_LIMIT)
    .map((i) => i.id);
  return { issueIds: oldest, rest: p.issueIds.length - oldest.length };
}

export function summaryOf(p: Part, s: Shared): ReleaseSummary {
  const facts = p.issueIds.flatMap((id) => s.facts.issues.get(id) ?? []);
  const judged = weighedOf(p, s).map((w) => w.readings.map((r) => r.view));
  const criteria = sumTotals(judged.map(totalsOf));
  const turn = turnFor(p, s, criteria);
  const { owner, act } = ownerOf(p, s);
  const split = splitOf(p, s);
  const reqs = [
    ...new Set(
      facts.flatMap((i) => {
        const key = i.requirementId ? s.facts.requirements.get(i.requirementId)?.key : undefined;
        return key ? [key] : [];
      }),
    ),
  ];
  return {
    key: p.version,
    version: p.version,
    runId: p.runId,
    state: p.state,
    current: s.current === p.version,
    landedOn: p.landedOn,
    shippedFailing: p.shippedFailing,
    ...turn,
    name: p.naming?.name ?? null,
    summary: p.naming?.summary ?? null,
    issueCount: p.issueIds.length,
    irreversible: irreversibleIn(p, s),
    requirements: reqs,
    criteria,
    verified: {
      level: releaseVerifiedLevel(criteria, p.verification),
      proven: criteria.proven,
      total: criteria.total,
      check: p.verification,
      provider: p.verification === 'provider' ? s.provider : null,
      judgedOn: s.facts.judgedOn,
    },
    contents: contentsOf(p, s),
    owner,
    ownerAct: act,
    can: {
      cut:
        p.state === 'draft' &&
        s.viewer?.isAdmin === true &&
        !p.gates.some((g) => g.kind === 'blocker'),
      decide:
        s.viewer?.mayApprove === true &&
        (p.state === 'draft' ? p.draftDecidable : approvalFacts(p)?.decision === null),
      split: split !== null,
    },
    split,
    openedAt: iso(p.openedAt),
    releasedAt: iso(p.releasedAt),
    at: lastChange(p, s),
    cutCount: p.cuts.length,
    continuedAs: p.continuedAs,
    draftApproval: p.draftApproval,
  };
}

function attemptView(a: ReleaseAttemptRow): ReleaseAttemptView {
  return {
    id: a.id,
    stage: a.stage,
    verdict: a.verdict,
    health: a.health,
    commit: a.commit,
    providerRef: a.providerRef,
    identity: a.identity,
    readings: a.readings ?? [],
    verdictReason: a.verdictReason,
    account: a.account,
    startedAt: a.startedAt.toISOString(),
    settledAt: iso(a.settledAt),
  };
}

const UNREAD: IssueLandingReading = {
  kind: 'unclassified',
  why: 'what its landing changed was not read',
  paths: [],
  source: null,
};

function issueViews(
  p: Part,
  s: Shared,
  waiting: ReleaseSummary['waitingOn'],
  landings: ReadonlyMap<string, IssueLandingReading>,
): ReleaseIssueView[] {
  const requests = changeRequestsOf(p, s);
  return p.issueIds.flatMap((id) => {
    const i = s.facts.issues.get(id);
    if (!i) return [];
    const criteria = totalsOf(criteriaOf(p, s, i));
    const landing = landings.get(id) ?? UNREAD;
    return [
      {
        id: i.id,
        key: i.key,
        title: i.title,
        status: i.status,
        section: reworkedSince(p, i) ? null : (i.releaseNotes?.section ?? null),
        requirement: i.requirementId
          ? (s.facts.requirements.get(i.requirementId)?.key ?? null)
          : null,
        proof: proofOf(criteria),
        criteria,
        // a landing closed its issues, and what it waits on next is the release's own turn
        waitingOn:
          p.state === 'landed'
            ? waiting
            : i.status === 'closed' || p.state === 'shipped'
              ? NOBODY
              : waiting,
        surfaces: surfacesOf(landing),
        landing,
        unclassified: gapOf(landing) !== null,
        changeRequest: requests.get(id) ?? null,
      },
    ];
  });
}

export function detailOf(
  p: Part,
  s: Shared,
  production: ReleaseDetail['production'],
  landings: ReadonlyMap<string, IssueLandingReading>,
  feedbackAnswered: ReleaseFeedbackView[],
  verifiedBy: ReleaseDetail['verifiedBy'],
  promotion: ReleaseDetail['promotion'] = null,
): Omit<ReleaseDetail, 'corrections'> {
  const summary = summaryOf(p, s);
  const issues = issueViews(p, s, summary.waitingOn, landings);
  const facts = p.issueIds.flatMap((id) => s.facts.issues.get(id) ?? []);
  const inRelease = new Set(p.issueIds);
  const reqIds = new Set(facts.flatMap((i) => (i.requirementId ? [i.requirementId] : [])));
  const latest = p.approvals[0] ?? null;
  const strip = ({ runId: _run, ...view }: ApprovalView): ReleaseApprovalView => view;
  const toldCount = (told: ReleaseFeedbackView['told']) =>
    feedbackAnswered.filter((f) => f.told === told).length;
  return {
    ...summary,
    feedbackAnswered,
    feedbackToldCounts: {
      on_ship: toldCount('on_ship'),
      told: toldCount('told'),
      not_told: toldCount('not_told'),
      before_notices: toldCount('before_notices'),
    },
    issues,
    changes: releaseChangesOf(issues.map((i) => ({ key: i.key, reading: i.landing }))),
    requirementsCompleted: [...reqIds]
      .flatMap((id) => s.facts.requirements.get(id) ?? [])
      .map((r) => completionOf(r, inRelease))
      .sort(
        (a, b) =>
          Number(b.completes) - Number(a.completes) ||
          a.key.localeCompare(b.key, 'en', { numeric: true }),
      ),
    // judged on a release it carries too (ISS-900)
    issueCriteria: weighedOf(p, s).map(({ issue, readings }) => ({
      key: issue.key,
      title: issue.title,
      criteria: readings.map((r) => r.view),
    })),
    notes: noteSections(p, s, landings),
    gates: p.gates,
    approval: latest ? strip(latest) : null,
    approvals: p.approvals.map(strip),
    approvers: s.approvers,
    approvalRequired: s.required,
    unapproved: p.unapproved,
    attempts: p.attempts.map(attemptView),
    cuts: p.cuts,
    production,
    ownerDeploys: s.ownerDeploys,
    promotion,
    verifiedBy,
    head: headOf(p),
    tag: p.tag,
  };
}
