/**
 * ISS-671 (direction B) — the ONE deterministic project-progress computation.
 *
 * The 54-issue incident (bot reported "nothing done" for a project with 54
 * completed issues) was a sampling error, not an arithmetic one: the chat
 * allowlist only ever gave the model `forge_issues.list` (`.limit(25)`,
 * newest-first). This module is the single source every caller (chat
 * injection, the output guard, any future UI/REST surface) reads instead.
 *
 * "Shipped" is NOT the same as "closed": `closed` also covers duplicates,
 * merges into another issue, and decided-not-to-do. `closed` only counts as
 * shipped when the issue's history shows it left the project's base-merge
 * state (`pipelineConfig.mergeStates.baseBranch`, default `released` — see
 * `issues/merged-at.ts`); `released` itself always counts, since a
 * just-released issue's `activity_log` row may not have landed yet.
 */

import { eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { type IssueStatus, activityLog, issueStatuses, issues, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { resolveMergeStates } from './merged-at.js';

export type ProgressBucket = 'shipped' | 'closed_unshipped' | 'in_flight' | 'remaining';

export interface ProjectProgress {
  /** Released, or closed with evidence the code actually shipped. */
  shipped: number;
  /** Closed WITHOUT ever leaving the base-merge state — duplicate, merged
   *  into another issue, decided not to do. Counts toward `total`, not
   *  toward `shipped`. */
  closedUnshipped: number;
  inFlight: number;
  remaining: number;
  total: number;
  byStatus: Record<IssueStatus, number>;
  computedAt: Date;
}

const REMAINING_STATUSES = new Set<IssueStatus>(['draft', 'waiting', 'needs_info', 'on_hold']);

// cm:guard the ONLY place issue statuses are bucketed into a progress figure — a second counter (chat self-count, a bespoke report) re-opens ISS-671's 54-issue incident
export function bucketOf(status: IssueStatus, everLeftBaseMergeState: boolean): ProgressBucket {
  if (status === 'released' || (status === 'closed' && everLeftBaseMergeState)) return 'shipped';
  if (status === 'closed') return 'closed_unshipped';
  if (REMAINING_STATUSES.has(status)) return 'remaining';
  return 'in_flight';
}

function emptyByStatus(): Record<IssueStatus, number> {
  return Object.fromEntries(issueStatuses.map((s) => [s, 0])) as Record<IssueStatus, number>;
}

/**
 * One grouped aggregate per project, joined against `activity_log` to check
 * (per `status`/`everLeftBaseMergeState` pair) whether the base-merge-state
 * transition ever happened. `bucketOf` maps each group to a progress bucket.
 * Returns `null` on a DB error (logged); callers MUST treat `null` as
 * fail-closed, not as "zero progress".
 */
export async function computeProjectProgress(
  projectId: string,
  dbi: typeof defaultDb = defaultDb,
): Promise<ProjectProgress | null> {
  try {
    const [projectRow] = await dbi
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const { baseBranch } = resolveMergeStates(projectRow?.agentConfig);

    const everLeftBaseMergeState = sql<boolean>`exists (
      select 1 from ${activityLog}
      where ${activityLog.issueId} = ${issues.id}
        and ${activityLog.action} = 'issue.statusChanged'
        and ${activityLog.payload}->>'to' = ${baseBranch}
    )`;

    const rows = await dbi
      .select({
        status: issues.status,
        everLeftBaseMergeState,
        count: sql<number>`count(*)::int`,
      })
      .from(issues)
      .where(eq(issues.projectId, projectId))
      .groupBy(issues.status, everLeftBaseMergeState);

    const byStatus = emptyByStatus();
    let shipped = 0;
    let closedUnshipped = 0;
    let inFlight = 0;
    let remaining = 0;
    for (const row of rows) {
      const status = row.status;
      const count = Number(row.count);
      byStatus[status] += count;
      const bucket = bucketOf(status, row.everLeftBaseMergeState);
      if (bucket === 'shipped') shipped += count;
      else if (bucket === 'closed_unshipped') closedUnshipped += count;
      else if (bucket === 'remaining') remaining += count;
      else inFlight += count;
    }
    return {
      shipped,
      closedUnshipped,
      inFlight,
      remaining,
      total: shipped + closedUnshipped + inFlight + remaining,
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
 * leaving that call to the model is the hole ISS-673 fell through. Each
 * figure carries its own definition so the model can't blur shipped into
 * closed-but-not-shipped on its own initiative.
 */
export function buildProgressFactsBlock(p: ProjectProgress): string {
  return [
    'Project progress (computed by the system from live data — AUTHORITATIVE).',
    'Do not recount, re-derive, or estimate these figures from issue lists; state them as given. Each figure below is a distinct bucket — do not merge them.',
    `- shipped (released to production): ${p.shipped}`,
    `- closed without shipping (duplicate, merged elsewhere, or decided not to do — not delivered work): ${p.closedUnshipped}`,
    `- in progress: ${p.inFlight}`,
    `- not started: ${p.remaining}`,
    `- total: ${p.total}`,
  ].join('\n');
}
