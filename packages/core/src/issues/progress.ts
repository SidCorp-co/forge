/**
 * ISS-671 (direction B) — the ONE deterministic project-progress computation.
 *
 * The 54-issue incident (bot reported "nothing done" for a project with 54
 * completed issues) was not an arithmetic bug: the chat allowlist only ever
 * gave the model `forge_issues.list` (`.limit(25)`, newest-first), so a
 * model that self-counts progress counts the 25 most recent issues — a
 * sampling error, not a math one. This module is the single source every
 * caller (chat injection, the output guard, any future UI/REST surface)
 * reads instead of re-deriving a count from a row list.
 */

import { eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { type IssueStatus, issueStatuses, issues } from '../db/schema.js';
import { logger } from '../logger.js';
import { TERMINAL_FOR_DISPATCH } from './apply-transition.js';

export type ProgressBucket = 'done' | 'in_flight' | 'remaining';

export interface ProjectProgress {
  done: number;
  inFlight: number;
  remaining: number;
  total: number;
  byStatus: Record<IssueStatus, number>;
  computedAt: Date;
}

const REMAINING_STATUSES = new Set<IssueStatus>(['draft', 'waiting', 'needs_info', 'on_hold']);

// cm:why a stale mergedAt on these statuses must never count a bounced-back or never-shipped issue as done on its own
const NEVER_DONE_VIA_MERGED_AT = new Set<IssueStatus>(['draft', 'on_hold', 'needs_info', 'reopen']);

// cm:guard the ONLY place issue statuses are bucketed into a progress figure — a second counter (chat self-count, a bespoke report) re-opens ISS-671's 54-issue incident
export function bucketOf(status: IssueStatus, mergedAt: Date | string | null): ProgressBucket {
  const done =
    TERMINAL_FOR_DISPATCH.has(status) ||
    (mergedAt != null && !NEVER_DONE_VIA_MERGED_AT.has(status));
  if (done) return 'done';
  if (REMAINING_STATUSES.has(status)) return 'remaining';
  return 'in_flight';
}

function emptyByStatus(): Record<IssueStatus, number> {
  return Object.fromEntries(issueStatuses.map((s) => [s, 0])) as Record<IssueStatus, number>;
}

/**
 * One grouped aggregate, no row cap and no row scan in application code —
 * the query itself buckets by (status, merged-or-not), and `bucketOf` maps
 * each group to a progress bucket. Returns `null` on a DB error (logged);
 * callers MUST treat `null` as fail-closed, not as "zero progress".
 */
export async function computeProjectProgress(
  projectId: string,
  dbi: typeof defaultDb = defaultDb,
): Promise<ProjectProgress | null> {
  try {
    const rows = await dbi
      .select({
        status: issues.status,
        merged: sql<boolean>`(${issues.mergedAt} is not null)`,
        count: sql<number>`count(*)::int`,
      })
      .from(issues)
      .where(eq(issues.projectId, projectId))
      .groupBy(issues.status, sql`(${issues.mergedAt} is not null)`);

    const byStatus = emptyByStatus();
    let done = 0;
    let inFlight = 0;
    let remaining = 0;
    for (const row of rows) {
      const status = row.status;
      const count = Number(row.count);
      byStatus[status] += count;
      const bucket = bucketOf(status, row.merged ? new Date() : null);
      if (bucket === 'done') done += count;
      else if (bucket === 'remaining') remaining += count;
      else inFlight += count;
    }
    return {
      done,
      inFlight,
      remaining,
      total: done + inFlight + remaining,
      byStatus,
      computedAt: new Date(),
    };
  } catch (err) {
    logger.error({ err, projectId }, 'issues/progress: computeProjectProgress query failed');
    return null;
  }
}

/**
 * Rendered as its own system-prompt section, unconditionally, on every
 * external chat turn — never gated on "is this a progress question", since
 * leaving that call to the model is the hole ISS-673 fell through.
 */
export function buildProgressFactsBlock(p: ProjectProgress): string {
  return [
    'Project progress (computed by the system from live data — AUTHORITATIVE).',
    'Do not recount, re-derive, or estimate these figures from issue lists; state them as given.',
    `- completed: ${p.done}`,
    `- in progress: ${p.inFlight}`,
    `- not started: ${p.remaining}`,
    `- total: ${p.total}`,
  ].join('\n');
}
