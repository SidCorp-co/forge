import { releaseNotesSections } from '@forge/contracts/release-notes';
import type {
  ReleaseApprovalView,
  ReleaseAttemptView,
  ReleaseContentGroup,
  ReleaseDetail,
  ReleaseGateView,
  ReleaseIssueView,
  ReleaseListResponse,
  ReleaseNoteSection,
  ReleasePerson,
  ReleaseProduction,
  ReleaseState,
  ReleaseSummary,
} from '@forge/contracts/releases';
import { RELEASE_ATTENTION_GROUPS } from '@forge/contracts/releases';
import { nobodyWaits } from '@forge/contracts/standing';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import type { ReleaseAttemptRow } from '../db/schema-release-ledger.js';
import { peopleOf } from '../lib/people.js';
import { notFound } from '../middleware/route-errors.js';
import { readReleasePath } from '../project-config/release-path.js';
import {
  type ApprovalView,
  approvalRequired,
  approvalsOfRuns,
  approvalViews,
} from './approvals.js';
import { collectReleaseBlockers } from './blockers.js';
import { type BoundsReading, readBounds } from './bounds.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { refuseRelease } from './refuse.js';
import { approversOf, loadReleaseFacts, type ReleaseFacts } from './release-facts.js';
import { gateViews } from './release-gates.js';
import {
  completionOf,
  headlineOf,
  proofOf,
  sumTotals,
  totalsOf,
  turnOf,
  type ViewerFacts,
} from './release-view.js';
import {
  formatReleaseVersion,
  nextReleaseVersion,
  parseReleaseVersion,
  RELEASE_VERSION_SHAPE,
} from './version.js';
import { currentReleaseVersion, highestCutVersion, releaseLineOf } from './version-store.js';
import { attemptsOf, issueIdsOf, type RunRow, versionRuns, versionStatus } from './versions.js';

const NOBODY = nobodyWaits('the issue has shipped');
const CHANGELOG_SECTIONS = releaseNotesSections.filter((s) => s !== 'Skip');

interface Part {
  version: string;
  runId: string | null;
  state: ReleaseState;
  issueIds: string[];
  openedAt: Date | null;
  releasedAt: Date | null;
  attempts: ReleaseAttemptRow[];
  approvals: ApprovalView[];
  gates: ReleaseGateView[];
  bounds: BoundsReading | null;
}

interface Shared {
  current: string | null;
  required: boolean;
  viewer: ViewerFacts | null;
  approvers: ReleasePerson[];
  facts: ReleaseFacts;
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
    crossedBounds: p.bounds?.crossedNames ?? [],
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

function summaryOf(p: Part, s: Shared): ReleaseSummary {
  const turn = turnFor(p, s);
  const facts = p.issueIds.flatMap((id) => s.facts.issues.get(id) ?? []);
  const { owner, act } = ownerOf(p, s);
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
    },
    openedAt: iso(p.openedAt),
    releasedAt: iso(p.releasedAt),
    at: lastChange(p, s),
  };
}

function attemptView(
  a: ReleaseAttemptRow,
  readers: ReadonlyMap<string, { name: string }>,
): ReleaseAttemptView {
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
    logTail: a.logTail,
    logTailTruncated: a.logTailTruncated,
    logTailReadBy: a.logTailReadBy ? (readers.get(a.logTailReadBy)?.name ?? null) : null,
    logTailReadAt: iso(a.logTailReadAt),
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
        userFacing: i.releaseNotes?.userFacing ?? '',
        technical: i.releaseNotes?.technical ?? null,
      })),
  })).filter((x) => x.entries.length > 0);
  return {
    sections,
    withoutNotes: facts.filter((i) => !i.releaseNotes).map((i) => ({ key: i.key, title: i.title })),
  };
}

function issueViews(p: Part, s: Shared, waiting: ReleaseSummary['waitingOn']): ReleaseIssueView[] {
  return p.issueIds.flatMap((id) => {
    const i = s.facts.issues.get(id);
    if (!i) return [];
    const criteria = totalsOf(i.criteria.map((c) => c.standing));
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
      },
    ];
  });
}

function detailOf(
  p: Part,
  s: Shared,
  production: ReleaseDetail['production'],
  readers: ReadonlyMap<string, { name: string }>,
): ReleaseDetail {
  const summary = summaryOf(p, s);
  const facts = p.issueIds.flatMap((id) => s.facts.issues.get(id) ?? []);
  const inRelease = new Set(p.issueIds);
  const reqIds = new Set(facts.flatMap((i) => (i.requirementId ? [i.requirementId] : [])));
  const latest = p.approvals[0] ?? null;
  const strip = ({ runId: _run, ...view }: ApprovalView): ReleaseApprovalView => view;
  return {
    ...summary,
    issues: issueViews(p, s, summary.waitingOn),
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
    attempts: p.attempts.map((a) => attemptView(a, readers)),
    bounds: {
      holding: p.bounds?.holding ?? false,
      bounds: p.bounds?.bounds ?? [],
    },
    production,
    head:
      latest?.evidence.commit ?? [...p.attempts].reverse().find((a) => a.commit)?.commit ?? null,
  };
}

async function draftPart(projectId: string): Promise<Part | null> {
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(issues.status, RELEASE_GATE_STATUS),
        isNull(issues.releaseBatchRunId),
      ),
    )
    .orderBy(sql`${issues.mergedAt} ASC NULLS LAST`);
  if (rows.length === 0) return null;
  const ids = rows.map((r) => r.id);
  const [highest, line, report] = await Promise.all([
    highestCutVersion(db, projectId),
    releaseLineOf(projectId),
    collectReleaseBlockers(projectId, { issueIds: ids, door: 'batch' }),
  ]);
  return {
    version: formatReleaseVersion(nextReleaseVersion(highest?.version ?? null, null, line)),
    runId: null,
    state: 'draft',
    issueIds: ids,
    openedAt: null,
    releasedAt: null,
    attempts: [],
    approvals: [],
    gates: gateViews(report.blockers, report.warnings),
    bounds: null,
  };
}

function runPart(
  run: RunRow,
  attempts: ReleaseAttemptRow[],
  approvals: ApprovalView[],
  required: boolean,
): Part {
  const state = versionStatus(run, attempts, approvals[0] ?? null, required);
  return {
    version: run.version,
    runId: run.id,
    state,
    issueIds: issueIdsOf(run.metadata),
    openedAt: run.startedAt,
    releasedAt: run.releasedAt,
    attempts,
    approvals,
    gates: [],
    bounds: state === 'in_progress' ? readBounds(attempts) : null,
  };
}

async function productionOf(projectId: string, current: string | null): Promise<ReleaseProduction> {
  const read = await readReleasePath(projectId);
  if (!read.ok) return { ok: false, reason: read.reason };
  const prod = read.path.production;
  return {
    ok: true,
    name: prod?.name ?? null,
    url: prod?.declaration.url ?? null,
    serving: current,
  };
}

async function sharedFor(
  projectId: string,
  parts: readonly Part[],
  viewer: ViewerFacts | null,
  current: string | null,
  required: boolean,
): Promise<Shared> {
  const [facts, approvers] = await Promise.all([
    loadReleaseFacts(
      projectId,
      parts.flatMap((p) => p.issueIds),
      parts.flatMap((p) => (p.runId ? [p.runId] : [])),
    ),
    approversOf(projectId),
  ]);
  return { current, required, viewer, approvers, facts };
}

async function runParts(projectId: string, version: string | undefined, required: boolean) {
  const runs = await versionRuns(projectId, version);
  const ids = runs.map((r) => r.id);
  const [attempts, rows] = await Promise.all([attemptsOf(ids), approvalsOfRuns(ids)]);
  const approvals = await approvalViews(rows);
  return runs.map((run) =>
    runPart(
      run,
      attempts.filter((a) => a.runId === run.id),
      approvals.filter((a) => a.runId === run.id),
      required,
    ),
  );
}

export async function listReleases(
  projectId: string,
  viewer: ViewerFacts | null,
): Promise<ReleaseListResponse> {
  const [required, current] = await Promise.all([
    approvalRequired(projectId),
    currentReleaseVersion(projectId),
  ]);
  const [runs, draft, production] = await Promise.all([
    runParts(projectId, undefined, required),
    draftPart(projectId),
    productionOf(projectId, current),
  ]);
  const parts = draft ? [draft, ...runs] : runs;
  const shared = await sharedFor(projectId, parts, viewer, current, required);
  const releases = parts.map((p) => summaryOf(p, shared));
  const counts = Object.fromEntries(
    RELEASE_ATTENTION_GROUPS.map((a) => [a, releases.filter((r) => r.attentionGroup === a).length]),
  ) as ReleaseListResponse['counts'];
  return { releases, counts, approvalRequired: required, production };
}

export async function readRelease(
  projectId: string,
  version: string,
  viewer: ViewerFacts | null,
): Promise<ReleaseDetail> {
  if (!parseReleaseVersion(version)) {
    throw refuseRelease(
      'RELEASE_VERSION_SHAPE',
      `${JSON.stringify(version)} is not a release version: ${RELEASE_VERSION_SHAPE}`,
    );
  }
  const [required, current] = await Promise.all([
    approvalRequired(projectId),
    currentReleaseVersion(projectId),
  ]);
  const [run] = await runParts(projectId, version, required);
  const part = run ?? (await draftPart(projectId));
  if (!part || part.version !== version) {
    throw notFound(`project ${projectId} has cut no version ${version}`);
  }
  const [shared, read, readers] = await Promise.all([
    sharedFor(projectId, [part], viewer, current, required),
    readReleasePath(projectId),
    peopleOf(part.attempts.map((a) => a.logTailReadBy)),
  ]);
  const prod = read.ok ? read.path.production : null;
  return detailOf(
    part,
    shared,
    prod ? { name: prod.name, url: prod.declaration.url ?? null } : null,
    readers,
  );
}
