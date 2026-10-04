/**
 * The failure histogram and its resume-continuity block, shaped.
 *
 * ISS-894 — shaped here, apart from any one door, so every surface that
 * reads it answers the same question the same way.
 */

import {
  FAILURE_CAUSE_ORIGIN,
  type FailureCause,
  isRealFailureCause,
  resolveFailureCause,
} from '../pipeline/index.js';
import { resumeDropsForProject, retryRescues, sessionFailures } from './queries.js';

function num(x: number | string | null | undefined): number {
  return typeof x === 'number' ? x : Number(x ?? 0);
}

const FAILED_SESSION_STATUSES: ReadonlySet<string> = new Set(['failed', 'cancelled_stale']);

interface ResumeContinuityRow {
  reason: string;
  sessions: number;
}

interface ResumeContinuity {
  offered: number;
  resumed: number;
  dropped: number;
  dropRate: number;
  rows: ResumeContinuityRow[];
}

interface SessionFailureRow {
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
async function loadResumeContinuity(projectId: string, days: number): Promise<ResumeContinuity> {
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
