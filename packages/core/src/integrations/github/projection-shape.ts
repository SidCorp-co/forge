/**
 * The three ordering rules the projection is built under, and the rollup.
 *
 * Pure functions over the stored maps, holding no db and no fetch, because the
 * thing worth testing here is what happens when deliveries arrive in the wrong
 * order — and that is a property of these functions rather than of Postgres.
 *
 * Webhook delivery is unordered and GitHub retries. A pull request, a check run
 * and a review change independently of one another, so each carries its own
 * evidence of which of two deliveries is later, and none of them is arrival
 * time. Arrival time is the one answer that is always available and always
 * wrong.
 */

import type {
  ProjectedCheckRun,
  ProjectedChecks,
  ProjectedReview,
  ProjectedReviews,
} from '../../db/schema-repo-projection.js';

/** How many check runs a row keeps beyond the ones on its current head. */
const FOREIGN_CHECK_RETENTION = 50;

// cm:guard the order is GitHub's own and it is MONOTONE — a run walks queued → in_progress → completed and never back. A delayed `queued` delivery arriving after the `completed` one is the ordinary shape of a retry, and taking it would put a finished check back in flight on a row a master is reading to decide whether the work is done.
const STATUS_RANK: Record<string, number> = { queued: 0, in_progress: 1, completed: 2 };

function rankOf(status: string): number {
  return STATUS_RANK[status] ?? -1;
}

/**
 * Whether an incoming check-run delivery is newer than the one already stored
 * under the same id.
 *
 * Rank first, `completed_at` second: two `completed` deliveries for one id are a
 * retry of the same fact, and the later completion is the one to keep.
 */
export function checkRunIsNewer(
  incoming: ProjectedCheckRun,
  stored: ProjectedCheckRun | undefined,
): boolean {
  if (!stored) return true;
  const a = rankOf(incoming.status);
  const b = rankOf(stored.status);
  if (a !== b) return a > b;
  const at = Date.parse(incoming.completedAt ?? '') || 0;
  const bt = Date.parse(stored.completedAt ?? '') || 0;
  return at >= bt;
}

/** The `checks` map with this delivery folded in, under the rule above. */
export function foldCheckRun(
  checks: ProjectedChecks,
  incoming: ProjectedCheckRun,
  currentHeadSha: string,
): ProjectedChecks {
  const stored = checks[incoming.id];
  const next: ProjectedChecks = checkRunIsNewer(incoming, stored)
    ? { ...checks, [incoming.id]: incoming }
    : { ...checks };
  return pruneChecks(next, currentHeadSha);
}

/**
 * Keep every run on the current head, and the most recently started
 * {@link FOREIGN_CHECK_RETENTION} of the rest.
 *
 * A row accumulates a run per check per head forever otherwise, and the ones
 * that are not on the current head are counted by nothing — they are kept only
 * so a delivery that arrives late for a head that has moved is still recorded
 * rather than dropped on the floor.
 */
export function pruneChecks(checks: ProjectedChecks, currentHeadSha: string): ProjectedChecks {
  const foreign = Object.values(checks).filter((c) => c.headSha !== currentHeadSha);
  if (foreign.length <= FOREIGN_CHECK_RETENTION) return checks;
  const keep = new Set(
    foreign
      .slice()
      .sort((x, y) => (Date.parse(y.startedAt ?? '') || 0) - (Date.parse(x.startedAt ?? '') || 0))
      .slice(0, FOREIGN_CHECK_RETENTION)
      .map((c) => c.id),
  );
  const out: ProjectedChecks = {};
  for (const [id, run] of Object.entries(checks)) {
    if (run.headSha === currentHeadSha || keep.has(id)) out[id] = run;
  }
  return out;
}

/**
 * The runs the current head's rollup is computed over: one per (app, name), the
 * latest `started_at` winning.
 *
 * Grouped by app AND name because two apps legitimately publish one name — a
 * GitHub Actions `build` beside a third-party `build` are two checks and both
 * count — while a re-run of one app's check on one head is the same check
 * answered again and must not be counted twice.
 */
export function currentHeadRuns(
  checks: ProjectedChecks,
  currentHeadSha: string,
): ProjectedCheckRun[] {
  const latest = new Map<string, ProjectedCheckRun>();
  for (const run of Object.values(checks)) {
    if (run.headSha !== currentHeadSha) continue;
    const key = `${run.app}\u001f${run.name}`;
    const held = latest.get(key);
    if (!held || startedOrder(run) >= startedOrder(held)) latest.set(key, run);
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// cm:guard the id is the tiebreak and it is COMPARED AS A NUMBER — GitHub's check-run ids are ascending integers, and two runs of one check started in the same second are otherwise ordered by whichever `Map` insertion happened to be last, which is arrival order wearing a different name.
function startedOrder(run: ProjectedCheckRun): number {
  const t = Date.parse(run.startedAt ?? '') || 0;
  return t * 1e6 + (Number(run.id) % 1e6);
}

export interface CheckRollup {
  total: number;
  success: number;
  failure: number;
  pending: number;
}

const SUCCESS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/** What the current head's checks say, counted from {@link currentHeadRuns}. */
// cm:guard `neutral` and `skipped` count as SUCCESS and `cancelled`, `timed_out` and `action_required` as failure — that is GitHub's own rollup and the operator has already learnt it. Inventing a fourth bucket here would make Forge's answer disagree with the one on the pull request page.
export function rollupOf(checks: ProjectedChecks, currentHeadSha: string): CheckRollup {
  const runs = currentHeadRuns(checks, currentHeadSha);
  let success = 0;
  let failure = 0;
  let pending = 0;
  for (const run of runs) {
    if (run.status !== 'completed') pending += 1;
    else if (SUCCESS_CONCLUSIONS.has(run.conclusion ?? '')) success += 1;
    else failure += 1;
  }
  return { total: runs.length, success, failure, pending };
}

/**
 * The `reviews` map with this submission folded in.
 *
 * A submission never clears a dismissal: the two are deliveries about one review
 * id, they arrive unordered, and GitHub does not change `submitted_at` when a
 * review is dismissed — so there is no timestamp that orders them and the flag
 * is the only thing that can carry the answer.
 */
export function foldReviewSubmitted(
  reviews: ProjectedReviews,
  incoming: ProjectedReview,
): ProjectedReviews {
  const stored = reviews[incoming.id];
  return { ...reviews, [incoming.id]: { ...incoming, dismissed: stored?.dismissed ?? false } };
}

/** The `reviews` map with this review marked dismissed, whether or not it is held yet. */
export function foldReviewDismissed(
  reviews: ProjectedReviews,
  incoming: ProjectedReview,
): ProjectedReviews {
  const stored = reviews[incoming.id];
  return { ...reviews, [incoming.id]: { ...(stored ?? incoming), dismissed: true } };
}

/**
 * Whether an incoming pull-request payload is at least as new as the one the
 * row's scalars were last written from.
 *
 * A row with no stored timestamp takes the payload: that is a row this delivery
 * is creating, or one written before the column existed.
 */
export function payloadIsNotOlder(
  incomingUpdatedAt: string | null | undefined,
  storedUpdatedAt: Date | string | null | undefined,
): boolean {
  if (!storedUpdatedAt) return true;
  const incoming = Date.parse(incomingUpdatedAt ?? '');
  if (Number.isNaN(incoming)) return true;
  const stored =
    storedUpdatedAt instanceof Date ? storedUpdatedAt.getTime() : Date.parse(storedUpdatedAt);
  if (Number.isNaN(stored)) return true;
  return incoming >= stored;
}
