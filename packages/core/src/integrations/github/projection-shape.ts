import type {
  ProjectedCheckRun,
  ProjectedChecks,
  ProjectedReview,
  ProjectedReviews,
} from '../../db/schema-repo-projection.js';

/** How many check runs a row keeps beyond the ones on its current head. */
const FOREIGN_CHECK_RETENTION = 50;

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

export function currentHeadRuns(
  checks: ProjectedChecks,
  currentHeadSha: string,
): ProjectedCheckRun[] {
  const latest = new Map<string, ProjectedCheckRun>();
  for (const run of Object.values(checks)) {
    if (run.headSha !== currentHeadSha) continue;
    const key = `${run.app}\u001f${run.name}`;
    const held = latest.get(key);
    if (!held || startedAfter(run, held)) latest.set(key, run);
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function startedAfter(run: ProjectedCheckRun, held: ProjectedCheckRun): boolean {
  const a = Date.parse(run.startedAt ?? '') || 0;
  const b = Date.parse(held.startedAt ?? '') || 0;
  if (a !== b) return a > b;
  return idOf(run.id) >= idOf(held.id);
}

/** A check-run id as the integer GitHub means, or 0 where it is not one. */
function idOf(id: string): bigint {
  try {
    return BigInt(id);
  } catch {
    return 0n;
  }
}

export interface CheckRollup {
  total: number;
  success: number;
  failure: number;
  pending: number;
}

const SUCCESS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/** What the current head's checks say, counted from {@link currentHeadRuns}. */
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
