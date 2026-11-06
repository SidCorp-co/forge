// Fast delivery's doors (REQ-79): the building agent's impact rating (BC-4), the cleanup debt it
// leaves (BC-3), the report a cleanup run writes (BC-9), and the ledger that surfaces all three with
// the changes waiting on a cleanup and the project's cleanup window. Agents record; Forge keeps what
// they recorded, refuses what its own rows contradict, and infers nothing.

import type {
  CarryDebtRequest,
  CleanupReportRequest,
  CleanupReportsQuery,
  CleanupReportView,
  DebtEvidenceRequest,
  DebtLedgerView,
  Impact,
  ImpactView,
  RecordDebtsRequest,
  RecordImpactRequest,
} from '@forge/contracts/cleanup';
import { HOLDING_RATING } from '@forge/contracts/cleanup';
import type { MergeCheckReport } from '@forge/contracts/merge-check';
import { db, type Tx } from '../db/client.js';
import { type Actor, issueDisplayIds, resolveIssueRouteRef } from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { RefusalError, refuser } from '../lib/refusal.js';
import type { PermissionFacts } from '../permissions/index.js';
import {
  readDeliveryShape,
  readFastDelivery,
  readLandingBranches,
} from '../project-config/index.js';
import { type CleanupWindow, fireProjectOf, readCleanupWindow } from '../schedules/index.js';
import { checkReportBase } from './report-base.js';
import {
  type CleanupRefusal,
  type CoverCandidate,
  debtRefusals,
  FAST_DELIVERY_OFF_DETAIL,
  reportOwed,
  reportRefusals,
  waitingOnCleanup,
  windowOffWords,
} from './rules.js';
import {
  currentRatings,
  greenCoverage,
  insertDebts,
  insertEvidence,
  insertImpact,
  insertReport,
  issueImpacts,
  lastHighLanding,
  lastReport,
  openDebts,
  ratedOpenIssues,
  readDebts,
  readReports,
  reportView,
  setCarried,
} from './store.js';

const refuse = refuser<CleanupRefusal['code']>('CLEANUP_REFUSED');

/**
 * The permission the route declares for an act whose project is found here (ISS-824): the route
 * hands its check in, so the check is the declaration's (`permissions/declared.ts:requireDeclared`).
 * The project-path doors are checked by their declaration before they reach this module.
 */
type HeldAsDeclared = (access: PermissionFacts) => void;

/** The issue `ref` names on this project, or null where it names none. */
async function issueOf(
  projectId: string,
  ref: string,
  userId: string,
): Promise<{ id: string; projectId: string } | null> {
  try {
    const issue = await resolveIssueRouteRef(ref, projectId, userId);
    return issue.projectId === projectId ? issue : null;
  } catch {
    return null;
  }
}

/**
 * The building agent's rating of its change (BC-4). A rating is kept whatever the project's setting:
 * it says something true about the change. On a project delivering fast a high one is owed a cleanup
 * report by the audit (`waits`), which holds nothing (BC-5). The answer names the project's cleanup window; it never makes one
 * (ISS-1049).
 */
export async function recordImpact(args: {
  issueRef: string;
  projectId?: string | undefined;
  request: RecordImpactRequest;
  userId: string;
  held: HeldAsDeclared;
}): Promise<{ impact: ImpactView; waits: boolean; window: CleanupWindow | null }> {
  const issue = await resolveIssueRouteRef(args.issueRef, args.projectId, args.userId);
  args.held(await loadProjectAccess(issue.projectId, args.userId));
  const { commit, ...impact } = args.request;
  const kept = await insertImpact(db, {
    projectId: issue.projectId,
    issueId: issue.id,
    impact,
    commit: commit?.toLowerCase() ?? null,
    ratedBy: args.userId,
  });
  const waits = impact.rating === HOLDING_RATING && (await readFastDelivery(issue.projectId));
  return { impact: kept, waits, window: await readCleanupWindow(issue.projectId) };
}

export async function readImpacts(args: {
  issueRef: string;
  projectId?: string | undefined;
  userId: string;
  held: HeldAsDeclared;
}): Promise<{ issueId: string; current: ImpactView | null; history: ImpactView[] }> {
  const issue = await resolveIssueRouteRef(args.issueRef, args.projectId, args.userId);
  args.held(await loadProjectAccess(issue.projectId, args.userId));
  const history = await issueImpacts(issue.id);
  return { issueId: issue.id, current: history[0] ?? null, history };
}

/**
 * Debt an agent saw and leaves for the cleanup lane (BC-3), on a project delivering fast. It is
 * recorded whether or not a window is on, and the answer says plainly where none is (ISS-1049).
 */
export async function recordDebts(args: {
  projectId: string;
  request: RecordDebtsRequest;
  userId: string;
}): Promise<{ debts: string[]; window: CleanupWindow | null; windowOff: string | null }> {
  const { projectId, request, userId } = args;
  if (!(await readFastDelivery(projectId))) {
    throw refuse('FAST_DELIVERY_OFF', FAST_DELIVERY_OFF_DETAIL, '/items');
  }
  const refusals = debtRefusals(request.items);
  if (refusals.length) throw new RefusalError(refusals, 'CLEANUP_REFUSED');
  let issueId: string | null = null;
  if (request.issue) {
    const issue = await issueOf(projectId, request.issue, userId);
    if (!issue) {
      throw refuse(
        'CLEANUP_REFUSED',
        `${request.issue} is not an issue of this project: name the issue you were working when you saw the debt, or leave \`issue\` out. Nothing was recorded`,
        '/issue',
      );
    }
    issueId = issue.id;
  }
  const debts = await insertDebts(db, {
    projectId,
    issueId,
    items: request.items,
    recordedBy: userId,
  });
  const window = await readCleanupWindow(projectId);
  return { debts, window, windowOff: windowOffWords(projectId, window) };
}

/**
 * Carry an open debt under a priced amnesty, or stop carrying it (REQ-79 BC-10): what it trades, what
 * it costs and what ends it, recorded once on the debt, which every later report and brief reads. A
 * project admin's act: an amnesty is the project's price, not a run's convenience.
 */
export async function carryDebt(args: {
  projectId: string;
  debtId: string;
  carry: CarryDebtRequest | null;
  userId: string;
}): Promise<{ debt: string; carried: boolean }> {
  const { projectId, debtId, carry, userId } = args;
  if (!(await setCarried({ projectId, debtId, carry, by: userId }))) {
    throw refuse(
      'CLEANUP_DEBT_UNKNOWN',
      `debt ${debtId} is not open on this project: it was never recorded here, or a cleanup report already cleared it, and only open debt is carried. Read the ledger (GET /api/projects/${projectId}/debts). Nothing was recorded`,
      '/debt',
    );
  }
  return { debt: debtId, carried: carry !== null };
}

/**
 * Keep evidence on an open debt (ISS-839): what someone found about it, in their name, which every
 * later cleanup brief and ledger read carries beside the debt. A writer's act: whoever saw it says it.
 */
export async function addDebtEvidence(args: {
  projectId: string;
  debtId: string;
  request: DebtEvidenceRequest;
  userId: string;
}): Promise<{ debt: string; evidence: true }> {
  const { projectId, debtId, request, userId } = args;
  if (!(await insertEvidence({ projectId, debtId, evidence: request.evidence, by: userId }))) {
    throw refuse(
      'CLEANUP_DEBT_UNKNOWN',
      `debt ${debtId} is not open on this project: it was never recorded here, or a cleanup report already cleared it, and evidence is kept on open debt only. Read the ledger (GET /api/projects/${projectId}/debts). Nothing was recorded`,
      '/debt',
    );
  }
  return { debt: debtId, evidence: true };
}

/**
 * A passing merge check's rating and the reds it passed as cleanup debt, in the check's own
 * transaction (the issue kernel's `recordMergeCheckCleanup` port), answering each debt's id in the
 * report's order so the check's record names it. The check's rules already held: debt reaches here
 * only on a project delivering fast, and never a red rated high.
 */
export async function recordMergeCheckCleanup(
  tx: Tx,
  args: { issueId: string; projectId: string; report: MergeCheckReport; actor: Actor },
): Promise<string[]> {
  const { issueId, projectId, report, actor } = args;
  const by = actor.type === 'user' ? actor.id : null;
  if (report.impact) {
    const commit = report.head.toLowerCase();
    await insertImpact(tx, { projectId, issueId, impact: report.impact, commit, ratedBy: by });
  }
  return report.debts?.length
    ? await insertDebts(tx, { projectId, issueId, items: report.debts, recordedBy: by })
    : [];
}

/**
 * What one cleanup run cleared, what remains and why (BC-9), and the changes rated high its green
 * head carries. Every debt open now is named once; whatever its rows contradict is refused by name,
 * and a base the project's source does not hold on its branch is refused (ISS-912). A report naming
 * its fire supersedes the one that fire filed before it.
 */
export async function recordCleanupReport(args: {
  projectId: string;
  request: CleanupReportRequest;
  userId: string;
}): Promise<{ report: CleanupReportView; supersedes: string[]; open: number; waiting: string[] }> {
  const { projectId, request, userId } = args;
  if (request.fire && (await fireProjectOf(request.fire)) !== projectId) {
    throw refuse(
      'CLEANUP_REFUSED',
      `fire ${request.fire} is no schedule fire of this project: name the fire the cleanup brief names, or leave \`fire\` out for a run a person started. Nothing was recorded`,
      '/fire',
    );
  }
  await checkReportBase(projectId, request.base);
  const covers: CoverCandidate[] = [];
  for (const ref of request.covers ?? []) {
    const issue = await issueOf(projectId, ref, userId);
    covers.push({ ref, issueId: issue?.id ?? null, key: null, rating: null });
  }
  const coveredIds = covers.flatMap((c) => (c.issueId ? [c.issueId] : []));
  const [ratings, keys] = await Promise.all([
    currentRatings(coveredIds),
    coveredIds.length ? issueDisplayIds(coveredIds) : Promise.resolve(new Map<string, string>()),
  ]);
  for (const c of covers) {
    if (!c.issueId) continue;
    c.key = keys.get(c.issueId) ?? null;
    c.rating = ratings.find((r) => r.issueId === c.issueId)?.impact.rating ?? null;
  }
  const kept = await db.transaction(async (tx) => {
    const refusals = reportRefusals(request, await openDebts(tx, projectId), covers);
    if (refusals.length) throw new RefusalError(refusals, 'CLEANUP_REFUSED');
    return insertReport(tx, {
      projectId,
      report: request,
      covers: [...new Set(coveredIds)],
      reportedBy: userId,
    });
  });
  const [open, waiting] = await Promise.all([openDebts(db, projectId), waitingIssues(projectId)]);
  return {
    report: reportView(kept.row, keys),
    supersedes: kept.supersedes,
    open: open.length,
    waiting: waiting.map((w) => w.issueKey),
  };
}

/** The project's current cleanup reports; `superseded` lists those a later one replaced beside them. */
export async function listCleanupReports(projectId: string, query: CleanupReportsQuery = {}) {
  return { reports: await readReports(projectId, { superseded: query.superseded === 'include' }) };
}

/**
 * The open issues rated high that no green cleanup since covers (BC-5), with their keys. Where
 * production deploys on land only the unlanded ones are listed: a landed one is live, and the audit
 * owes the base its report through `cleanupReportOwed` instead.
 */
async function waitingIssues(projectId: string): Promise<DebtLedgerView['waiting']> {
  const open = await ratedOpenIssues(projectId, (await readDeliveryShape(projectId)).onLand);
  const ids = open.map((o) => o.id);
  const [ratings, coverage] = await Promise.all([
    currentRatings(ids),
    greenCoverage(projectId, ids),
  ]);
  const waiting = waitingOnCleanup(ratings, coverage);
  if (waiting.length === 0) return [];
  const keys = await issueDisplayIds(waiting.map((w) => w.issueId));
  const status = new Map(open.map((o) => [o.id, o.status]));
  return waiting.map((w) => ({
    issueId: w.issueId,
    issueKey: keys.get(w.issueId) ?? w.issueId,
    status: status.get(w.issueId) ?? '',
    impact: w.impact,
  }));
}

/** The ledger (BC-3, BC-7): open and cleared debt, the changes waiting on a cleanup, the window. */
export async function readLedger(projectId: string): Promise<DebtLedgerView> {
  const [fast, debts, waiting, window] = await Promise.all([
    readFastDelivery(projectId),
    readDebts(projectId),
    waitingIssues(projectId),
    readCleanupWindow(projectId),
  ]);
  return {
    fast,
    open: debts.open,
    cleared: debts.cleared,
    waiting: fast ? waiting : [],
    window,
    windowOff: windowOffWords(projectId, window),
  };
}

/** The rating a landing is judged at: the check's own where it sends one, else the issue's current. */
async function landingRating(issueId: string, sent: Impact | undefined): Promise<Impact | null> {
  if (sent) return sent;
  return (await currentRatings([issueId]))[0]?.impact ?? null;
}

/**
 * Whether the mark of this issue owes a merge check (the issue kernel's `cleanupOwesLandingCheck`
 * port): it is rated high on a project delivering fast whose production deploys on land. The check
 * refuses nothing for the cleanup; it records the change's rating and the debt it leaves, which the
 * audit window then takes, so a project that asks no merge check (a `yolo` gate profile) still leaves
 * that record for a high change.
 */
export async function cleanupOwesLandingCheck(args: {
  issueId: string;
  projectId: string;
}): Promise<boolean> {
  const shape = await readDeliveryShape(args.projectId);
  if (!shape.fast || !shape.onLand) return false;
  return (await landingRating(args.issueId, undefined))?.rating === HOLDING_RATING;
}

/**
 * Whether the base owes the audit a cleanup report after a change rated high landed (BC-5,
 * `rules.ts:reportOwed`): a cleanup window starts a run on it even with no debt to clear but carried
 * debt (ISS-842). Nothing waits on it; the landing has happened. True where the project names no
 * branch its work lands on: then no report can be matched, so the run goes.
 */
export async function cleanupReportOwed(projectId: string): Promise<boolean> {
  const shape = await readDeliveryShape(projectId);
  if (!shape.fast || !shape.onLand) return false;
  const { defaultBranch } = await readLandingBranches(projectId);
  if (!defaultBranch) return true;
  const [last, highAt] = await Promise.all([
    lastReport(db, projectId, defaultBranch),
    lastHighLanding(projectId, NO_ISSUE),
  ]);
  return reportOwed(last, highAt) !== null;
}

/** An issue id no row holds: `lastHighLanding` then excepts none. */
const NO_ISSUE = '00000000-0000-0000-0000-000000000000';

export { waitingIssues };
