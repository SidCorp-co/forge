// A release's views, projected from what the loaders in release-read.ts read: pure, no I/O.

import { releaseNoteAttention } from '@forge/contracts/content-language';
import { releaseNotesSections } from '@forge/contracts/release-notes';
import {
  type IssueLandingReading,
  RELEASE_ROSTER_LIMIT,
  type ReleaseApprovalView,
  type ReleaseAttemptView,
  type ReleaseContentGroup,
  type ReleaseDetail,
  type ReleaseFeedbackView,
  type ReleaseGateView,
  type ReleaseIssueView,
  type ReleaseNoteSection,
  type ReleasePerson,
  type ReleaseSplit,
  type ReleaseState,
  type ReleaseSummary,
} from '@forge/contracts/releases';
import { nobodyWaits } from '@forge/contracts/standing';
import type { ReleaseAttemptRow } from '../db/schema-release-ledger.js';
import type { ApprovalView } from './approvals.js';
import { gapOf, releaseChangesOf, surfacesOf } from './landing-surfaces.js';
import type { ReleaseFacts } from './release-facts.js';
import {
  completionOf,
  headlineOf,
  proofOf,
  sumTotals,
  totalsOf,
  turnOf,
  type ViewerFacts,
} from './release-view.js';

const NOBODY = nobodyWaits('the issue has shipped');
const CHANGELOG_SECTIONS = releaseNotesSections.filter((s) => s !== 'Skip');

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
  /** The commit a finished release's probes verified live (`metadata.finish.commit`); null before. */
  commit: string | null;
}

export interface Shared {
  current: string | null;
  required: boolean;
  viewer: ViewerFacts | null;
  approvers: ReleasePerson[];
  facts: ReleaseFacts;
  /** The project's content language tag, which its release notes are written in. */
  contentLanguage: string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function inFlightStage(attempts: readonly ReleaseAttemptRow[]) {
  return [...attempts].reverse().find((a) => a.settledAt === null)?.stage ?? null;
}

function approvalFacts(p: Part) {
  const latest = p.approvals[0];
  return latest
    ? { decision: latest.decision, requestedBy: latest.requestedBy, reason: latest.reason }
    : null;
}

function turnFor(p: Part, s: Shared) {
  return turnOf({
    state: p.state,
    version: p.version,
    approval: approvalFacts(p),
    approvers: s.approvers,
    viewer: s.viewer,
    gates: p.gates.filter((g) => g.kind === 'blocker'),
    inFlight: inFlightStage(p.attempts),
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

function contentsOf(p: Part, s: Shared): ReleaseContentGroup[] {
  const groups = new Map<string | null, ReleaseContentGroup>();
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
      key: issue.key,
      title: issue.title,
      status: issue.status,
      proof: proofOf(totalsOf(issue.criteria.map((c) => c.standing))),
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
  const turn = turnFor(p, s);
  const facts = p.issueIds.flatMap((id) => s.facts.issues.get(id) ?? []);
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
    ...turn,
    headline: headlineOf(
      facts.map((i) => ({
        section: i.releaseNotes?.section ?? null,
        text:
          i.releaseNotes && i.releaseNotes.section !== 'Skip' ? i.releaseNotes.userFacing : i.title,
      })),
    ),
    issueCount: p.issueIds.length,
    requirements: reqs,
    criteria: sumTotals(facts.map((i) => totalsOf(i.criteria.map((c) => c.standing)))),
    contents: contentsOf(p, s),
    owner,
    ownerAct: act,
    can: {
      cut:
        p.state === 'draft' &&
        s.viewer?.isAdmin === true &&
        !p.gates.some((g) => g.kind === 'blocker'),
      decide: s.viewer?.mayApprove === true && approvalFacts(p)?.decision === null,
      split: split !== null,
    },
    split,
    openedAt: iso(p.openedAt),
    releasedAt: iso(p.releasedAt),
    at: lastChange(p, s),
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

function noteSections(p: Part, s: Shared) {
  const facts = p.issueIds.flatMap((id) => s.facts.issues.get(id) ?? []);
  const sections: ReleaseNoteSection[] = CHANGELOG_SECTIONS.map((section) => ({
    section,
    entries: facts
      .filter((i) => i.releaseNotes?.section === section)
      .map((i) => ({
        key: i.key,
        title: i.title,
        userFacing: i.releaseNotes?.userFacing ?? '',
        technical: i.releaseNotes?.technical ?? null,
      })),
  })).filter((x) => x.entries.length > 0);
  // a reader aid on the draft, not a gate: the release gate's own reasons are unchanged
  const attention = facts.flatMap((i) => {
    if (!i.releaseNotes || i.releaseNotes.section === 'Skip') return [];
    const found = releaseNoteAttention(s.contentLanguage, i.releaseNotes.userFacing);
    return found.notInLanguage || found.references.length > 0
      ? [{ key: i.key, title: i.title, ...found }]
      : [];
  });
  return {
    sections,
    withoutNotes: facts.filter((i) => !i.releaseNotes).map((i) => ({ key: i.key, title: i.title })),
    language: s.contentLanguage,
    attention,
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
  return p.issueIds.flatMap((id) => {
    const i = s.facts.issues.get(id);
    if (!i) return [];
    const criteria = totalsOf(i.criteria.map((c) => c.standing));
    const landing = landings.get(id) ?? UNREAD;
    return [
      {
        id: i.id,
        key: i.key,
        title: i.title,
        status: i.status,
        section: i.releaseNotes?.section ?? null,
        requirement: i.requirementId
          ? (s.facts.requirements.get(i.requirementId)?.key ?? null)
          : null,
        proof: proofOf(criteria),
        criteria,
        waitingOn: i.status === 'closed' || p.state === 'shipped' ? NOBODY : waiting,
        surfaces: surfacesOf(landing),
        landing,
        unclassified: gapOf(landing) !== null,
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
): ReleaseDetail {
  const summary = summaryOf(p, s);
  const issues = issueViews(p, s, summary.waitingOn, landings);
  const facts = p.issueIds.flatMap((id) => s.facts.issues.get(id) ?? []);
  const inRelease = new Set(p.issueIds);
  const reqIds = new Set(facts.flatMap((i) => (i.requirementId ? [i.requirementId] : [])));
  const latest = p.approvals[0] ?? null;
  const strip = ({ runId: _run, ...view }: ApprovalView): ReleaseApprovalView => view;
  return {
    ...summary,
    feedbackAnswered,
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
    issueCriteria: facts.map((i) => ({ key: i.key, title: i.title, criteria: i.criteria })),
    notes: noteSections(p, s),
    gates: p.gates,
    approval: latest ? strip(latest) : null,
    approvals: p.approvals.map(strip),
    approvers: s.approvers,
    approvalRequired: s.required,
    attempts: p.attempts.map(attemptView),
    production,
    head:
      p.commit ??
      latest?.evidence.commit ??
      [...p.attempts].reverse().find((a) => a.commit)?.commit ??
      null,
  };
}
