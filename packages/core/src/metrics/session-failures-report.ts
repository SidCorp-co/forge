/**
 * The failure histogram and its resume-continuity block, shaped.
 *
 * ISS-894 — this shaping lived inside `forge_metrics.session_failures`'s
 * handler, which meant REST could only ever expose the raw query underneath
 * it. Moved here so both surfaces answer the same question the same way, and
 * so the tool can go without taking the rule with it.
 */

import {
  FAILURE_CAUSE_ORIGIN,
  type FailureCause,
  isRealFailureCause,
  resolveFailureCause,
} from '../pipeline/failure-causes.js';
import { resumeDropsForProject, retryRescues, sessionFailures } from './queries.js';

function num(x: number | string | null | undefined): number {
  return typeof x === 'number' ? x : Number(x ?? 0);
}

// cm:guard the two statuses that mean the session itself ended badly. `completed` and `completed_via_recovery` are deliberately absent even when they carry a `failure_reason` — a recovered session succeeded, and counting its old reason would report a rescue as a death.
const FAILED_SESSION_STATUSES: ReadonlySet<string> = new Set(['failed', 'cancelled_stale']);

export interface ResumeContinuityRow {
  reason: string;
  sessions: number;
}

export interface ResumeContinuity {
  offered: number;
  resumed: number;
  dropped: number;
  dropRate: number;
  rows: ResumeContinuityRow[];
}

export interface SessionFailureRow {
  cause: FailureCause;
  origin: string;
  sessions: number;
  isRealFailure: boolean;
  lastAt: string | null;
}

/**
 * ISS-887 — of the attempts that HAD a prior transcript to continue, how many continued it and,
 * for the rest, which of the seven `ResumeDropReason` paths took it away.
 */
// cm:guard `offered` is the denominator and it is defined by `priorClaudeSessionId IS NOT NULL`, never by counting rows. That predicate is what keeps attempt 1 out: an attempt with no prior session to continue is the normal shape of a first try, and folding those into the denominator would make the rate shrink as the project does MORE fresh work.
// cm:guard this must NOT inherit the failure histogram's status filter. A resume is dropped on healthy dispatches too — restricting it to `failed`/`cancelled_stale` rows would measure the drop rate of attempts that later died, report it as the drop rate, and leave both numbers wrong.
export async function loadResumeContinuity(
  projectId: string,
  days: number,
): Promise<ResumeContinuity> {
  const result = await resumeDropsForProject(projectId, days);
  let offered = 0;
  let dropped = 0;
  const rows: ResumeContinuityRow[] = [];
  for (const row of result) {
    const sessions = num(row.sessions);
    offered += sessions;
    if (row.drop_reason === null) continue;
    dropped += sessions;
    rows.push({ reason: row.drop_reason, sessions });
  }
  rows.sort((a, b) => b.sessions - a.sessions || a.reason.localeCompare(b.reason));
  return {
    offered,
    resumed: offered - dropped,
    dropped,
    dropRate: offered === 0 ? 0 : dropped / offered,
    rows,
  };
}

export async function buildSessionFailuresReport(projectId: string, days: number) {
  const result = await sessionFailures(projectId, days);

  const byCause = new Map<FailureCause, { sessions: number; lastAt: Date | null }>();
  let nonFailedWithFailureReason = 0;
  for (const row of result) {
    if (!FAILED_SESSION_STATUSES.has(row.status ?? '')) {
      nonFailedWithFailureReason += num(row.sessions);
      continue;
    }
    const cause = resolveFailureCause(row.failure_reason);
    const prev = byCause.get(cause);
    const lastAt = row.last_at ? new Date(row.last_at) : null;
    byCause.set(cause, {
      sessions: (prev?.sessions ?? 0) + num(row.sessions),
      lastAt:
        prev?.lastAt && lastAt
          ? prev.lastAt > lastAt
            ? prev.lastAt
            : lastAt
          : (lastAt ?? prev?.lastAt ?? null),
    });
  }

  const rows: SessionFailureRow[] = [...byCause.entries()]
    .map(([cause, agg]) => ({
      cause,
      origin: FAILURE_CAUSE_ORIGIN[cause],
      sessions: agg.sessions,
      isRealFailure: isRealFailureCause(cause),
      lastAt: agg.lastAt ? agg.lastAt.toISOString() : null,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.cause.localeCompare(b.cause));

  const total = rows.reduce((sum, row) => sum + row.sessions, 0);
  const unclassified = byCause.get('unclassified')?.sessions ?? 0;
  return {
    rows,
    total,
    unclassified,
    unclassifiedRate: total === 0 ? 0 : unclassified / total,
    nonFailedWithFailureReason,
    resumeContinuity: await loadResumeContinuity(projectId, days),
    windowDays: days,
    projectId,
  };
}

export async function buildRetryRescuesReport(projectId: string, days: number) {
  const result = await retryRescues(projectId, days);
  const rows = result.map((row) => ({
    failureKind: row.failure_kind,
    failureReason: row.failure_reason,
    rescues: num(row.rescues),
    lastRescuedAt:
      row.last_rescued_at instanceof Date
        ? row.last_rescued_at.toISOString()
        : String(row.last_rescued_at),
  }));
  return {
    rows,
    total: rows.reduce((sum, r) => sum + r.rescues, 0),
    windowDays: days,
    projectId,
  };
}
