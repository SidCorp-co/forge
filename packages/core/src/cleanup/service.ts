// Fast delivery's doors (REQ-79): the building agent's impact rating (BC-4), the cleanup debt it
// leaves (BC-3), the report a cleanup run writes (BC-9), and the ledger that surfaces all three with
// the changes waiting on a cleanup and the project's cleanup window. Agents record; Forge keeps what
// they recorded, refuses what its own rows contradict, and infers nothing.

import type {
  CarryDebtRequest,
  CleanupReportRequest,
  CleanupReportView,
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
import { requireHeld } from '../permissions/index.js';
import { readDeliveryShape, readFastDelivery } from '../project-config/index.js';
import {
  type CleanupWindow,
  ensureCleanupWindow,
  fireProjectOf,
  readCleanupWindow,
} from '../schedules/index.js';
import {
  type CleanupRefusal,
  type CoverCandidate,
  debtRefusals,
  FAST_DELIVERY_OFF_DETAIL,
  type LandingRefusal,
  landingRefusal,
  reportRefusals,
  waitingOnCleanup,
} from './rules.js';
import {
  currentRatings,
  greenCoverage,
  insertDebts,
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

async function writer(projectId: string, userId: string): Promise<void> {
  requireHeld(await loadProjectAccess(projectId, userId), 'project.write');
}

async function reader(projectId: string, userId: string): Promise<void> {
  requireHeld(await loadProjectAccess(projectId, userId), 'project.read');
}

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
 * it says something true about the change. Only on a project delivering fast does a high one hold the
 * change from production (BC-5), and then the project is given its cleanup window if it has none.
 */
export async function recordImpact(args: {
  issueRef: string;
  projectId?: string | undefined;
  request: RecordImpactRequest;
  userId: string;
}): Promise<{ impact: ImpactView; waits: boolean; window: CleanupWindow | null }> {
  const issue = await resolveIssueRouteRef(args.issueRef, args.projectId, args.userId);
  await writer(issue.projectId, args.userId);
  const { commit, ...impact } = args.request;
  const kept = await insertImpact(db, {
    projectId: issue.projectId,
    issueId: issue.id,
    impact,
    commit: commit?.toLowerCase() ?? null,
    ratedBy: args.userId,
  });
  const waits = impact.rating === HOLDING_RATING && (await readFastDelivery(issue.projectId));
  const window = waits
    ? await ensureCleanupWindow(issue.projectId)
    : await readCleanupWindow(issue.projectId);
  return { impact: kept, waits, window };
}

export async function readImpacts(args: {
  issueRef: string;
  projectId?: string | undefined;
  userId: string;
}): Promise<{ issueId: string; current: ImpactView | null; history: ImpactView[] }> {
  const issue = await resolveIssueRouteRef(args.issueRef, args.projectId, args.userId);
  const history = await issueImpacts(issue.id);
  return { issueId: issue.id, current: history[0] ?? null, history };
}

/** Debt an agent saw and leaves for the cleanup lane (BC-3), on a project delivering fast. */
export async function recordDebts(args: {
  projectId: string;
  request: RecordDebtsRequest;
  userId: string;
}): Promise<{ debts: string[]; window: CleanupWindow | null }> {
  const { projectId, request, userId } = args;
  await writer(projectId, userId);
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
  return { debts, window: await ensureCleanupWindow(projectId) };
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
  requireHeld(await loadProjectAccess(projectId, userId), 'project.admin');
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
  const debts = report.debts?.length
    ? await insertDebts(tx, { projectId, issueId, items: report.debts, recordedBy: by })
    : [];
  if (debts.length || report.impact?.rating === HOLDING_RATING) {
    await ensureCleanupWindow(projectId);
  }
  return debts;
}

/**
 * What one cleanup run cleared, what remains and why (BC-9), and the changes rated high its green
 * head carries. Every debt open now is named once; whatever its rows contradict is refused by name.
 */
export async function recordCleanupReport(args: {
  projectId: string;
  request: CleanupReportRequest;
  userId: string;
}): Promise<{ report: CleanupReportView; open: number; waiting: string[] }> {
  const { projectId, request, userId } = args;
  await writer(projectId, userId);
  if (request.fire && (await fireProjectOf(request.fire)) !== projectId) {
    throw refuse(
      'CLEANUP_REFUSED',
      `fire ${request.fire} is no schedule fire of this project: name the fire the cleanup brief names, or leave \`fire\` out for a run a person started. Nothing was recorded`,
      '/fire',
    );
  }
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
  const row = await db.transaction(async (tx) => {
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
    report: reportView(row, keys),
    open: open.length,
    waiting: waiting.map((w) => w.issueKey),
  };
}

export async function listCleanupReports(projectId: string, userId: string) {
  await reader(projectId, userId);
  return { reports: await readReports(projectId) };
}

/**
 * The open issues rated high that no green cleanup since covers (BC-5), with their keys. Where
 * production deploys on land these are the changes waiting to land: a landed one is already live.
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
export async function readLedger(projectId: string, userId: string): Promise<DebtLedgerView> {
  await reader(projectId, userId);
  const [fast, debts, waiting, window] = await Promise.all([
    readFastDelivery(projectId),
    readDebts(projectId),
    waitingIssues(projectId),
    readCleanupWindow(projectId),
  ]);
  return { fast, open: debts.open, cleared: debts.cleared, waiting: fast ? waiting : [], window };
}

/**
 * Which of `issueIds` wait for a green cleanup before a person promotes them (BC-5, BC-6): none where
 * the project does not deliver fast, none where production deploys on land (there the change is held
 * from landing instead, `cleanupLandingRefusal`: a roster hold would only hold the record of a change
 * already live), else each rated high now that no green report since that rating covers.
 */
export async function cleanupWaiting(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, { reason: string; type: string }>> {
  if (issueIds.length === 0) return new Map();
  const shape = await readDeliveryShape(projectId);
  if (!shape.fast || shape.onLand) return new Map();
  const [ratings, coverage] = await Promise.all([
    currentRatings(issueIds),
    greenCoverage(projectId, issueIds),
  ]);
  return new Map(
    waitingOnCleanup(ratings, coverage).map((w) => [
      w.issueId,
      { reason: w.impact.reason, type: w.impact.type },
    ]),
  );
}

/** The rating a landing is judged at: the check's own where it sends one, else the issue's current. */
async function landingRating(issueId: string, sent: Impact | undefined): Promise<Impact | null> {
  if (sent) return sent;
  return (await currentRatings([issueId]))[0]?.impact ?? null;
}

/**
 * Why this change may not land now (REQ-79 r4 BC-5), or null (the issue kernel's
 * `cleanupLandingRefusal` port). On a project delivering fast whose production deploys on land, a
 * change rated high lands only once a cleanup has left the base green; see `rules.ts:landingRefusal`.
 * The merge check asks it before the push; the mark asks `cleanupOwesLandingCheck`.
 */
export async function cleanupLandingRefusal(args: {
  issueId: string;
  projectId: string;
  report: MergeCheckReport;
}): Promise<LandingRefusal | null> {
  const { issueId, projectId, report } = args;
  const shape = await readDeliveryShape(projectId);
  if (!shape.fast || !shape.onLand) return null;
  const rating = await landingRating(issueId, report.impact);
  if (rating?.rating !== HOLDING_RATING) return null;
  const [open, last, highAt, window, key] = await Promise.all([
    openDebts(db, projectId),
    lastReport(db, projectId, report.base.branch),
    lastHighLanding(projectId, issueId),
    readCleanupWindow(projectId),
    issueDisplayIds([issueId]),
  ]);
  return landingRefusal({
    ...shape,
    rating,
    issueRef: key.get(issueId) ?? issueId,
    open,
    ownHigh: report.debts?.filter((d) => d.impact.rating === HOLDING_RATING).length ?? 0,
    last,
    lastHighLandedAt: highAt,
    window,
  });
}

/**
 * Whether the mark of this issue owes a merge check (the issue kernel's `cleanupOwesLandingCheck`
 * port): it is rated high on a project delivering fast whose production deploys on land. Without it a
 * project that asks no merge check (a `yolo` gate profile) would land a high change past the door
 * above by never calling it.
 */
export async function cleanupOwesLandingCheck(args: {
  issueId: string;
  projectId: string;
}): Promise<boolean> {
  const shape = await readDeliveryShape(args.projectId);
  if (!shape.fast || !shape.onLand) return false;
  return (await landingRating(args.issueId, undefined))?.rating === HOLDING_RATING;
}

export { waitingIssues };
