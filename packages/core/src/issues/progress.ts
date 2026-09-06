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
 * merges into another issue, and decided-not-to-do. See `bucketOf` and
 * `computeProjectProgress` for what counts as shipped-evidence.
 */

import { eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { activityLog, type IssueStatus, issueStatuses, issues, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { resolveMergeStates } from './merged-at.js';

export type ProgressBucket = 'shipped' | 'closed_unshipped' | 'in_flight' | 'remaining';

export interface ProjectProgress {
  /** Released, or closed with evidence the code actually shipped. */
  shipped: number;
  /** Closed with NO evidence found that it shipped — duplicate, merged into
   *  another issue, decided not to do, OR a shipped issue this predicate
   *  can't see (e.g. code landed under a different issue's branch). Absence
   *  of evidence is not evidence the work was dropped — see
   *  `buildProgressFactsBlock`'s rendered label. Counts toward `total`, not
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
export function bucketOf(status: IssueStatus, hasShippedEvidence: boolean): ProgressBucket {
  if (status === 'released' || (status === 'closed' && hasShippedEvidence)) return 'shipped';
  // cm:guard `dropped` is terminal and shipped nothing BY DEFINITION — falling through to the `in_flight` default would count every dropped issue as work still in progress, forever, which is the shape of the ISS-671 incident this function exists to prevent
  if (status === 'closed' || status === 'dropped') return 'closed_unshipped';
  if (REMAINING_STATUSES.has(status)) return 'remaining';
  return 'in_flight';
}

function emptyByStatus(): Record<IssueStatus, number> {
  return Object.fromEntries(issueStatuses.map((s) => [s, 0])) as Record<IssueStatus, number>;
}

/**
 * One grouped aggregate per project, joined against `activity_log` to check
 * (per `status`/`hasShippedEvidence` pair) whether shipped-evidence exists:
 * a transition into the base- or production-merge state, OR `merged_at` set
 * together with a transition into a post-code status. `bucketOf` maps each
 * group to a progress bucket. Returns `null` on a DB error (logged); callers
 * MUST treat `null` as fail-closed, not as "zero progress".
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
    const { baseBranch, productionBranch } = resolveMergeStates(projectRow?.agentConfig);

    const leftMergeState = sql`exists (
      select 1 from ${activityLog}
      where ${activityLog.issueId} = ${issues.id}
        and ${activityLog.action} = 'issue.statusChanged'
        and ${activityLog.payload}->>'to' in (${baseBranch}, ${productionBranch})
    )`;

    // cm:guard ISS-817 — `merged_at` alone is NOT shipped-evidence: markMergedOnClose stamps it on EVERY close, so this is the WHOLE discriminator now that the post-code conjunct is gone. Drop the NOT and the predicate degenerates to "closed", reporting never-merged code as shipped.
    // cm:why the auto-stamp and the close's activity_log row are written in ONE transaction and Postgres now() is transaction-start time, so their timestamps are identical; a genuine base-merge stamp came from an earlier transaction and cannot collide
    // cm:edge lockstep -> packages/core/src/issues/apply-transition.ts — this reads the timestamp identity that markMergedOnClose + the activity_log write produce together; splitting those two writes apart silently re-inflates `shipped`
    const stampedByCloseItself = sql`exists (
      select 1 from ${activityLog}
      where ${activityLog.issueId} = ${issues.id}
        and ${activityLog.action} = 'issue.statusChanged'
        and ${activityLog.payload}->>'to' = 'closed'
        and ${activityLog.createdAt} = ${issues.mergedAt}
    )`;

    // cm:why ISS-791 — the second disjunct asks only whether the stamp was DELIBERATE, because exactly three writers set `merged_at` and the question partitions them: `markMergedIfLeavingBase` is already the first disjunct, `markMergedOnClose` is the auto-stamp the `not` here excludes, and `applyMergeMarker` is the audited claim gated by `pipeline/work-evidence.ts`. It used to also require a logged transition into developed/testing/tested/released, which no hand-driven issue ever has — so work finished outside the pipeline and claimed through the one sanctioned surface was reported as "closed with NO evidence it shipped".
    const hasShippedEvidence = sql<boolean>`(${leftMergeState} or (${issues.mergedAt} is not null and not ${stampedByCloseItself}))`;

    // cm:why evidence is computed per issue in a derived table then grouped — grouping DIRECTLY on the expression made Postgres reject it ("subquery uses ungrouped column issues.id"): the builder renders it differently in the select list vs the GROUP BY, so the two stop matching
    const rows = await dbi.execute<{
      status: IssueStatus;
      has_shipped_evidence: boolean;
      count: number;
    }>(sql`
      select status, has_shipped_evidence, count(*)::int as count
      from (
        select ${issues.status} as status, ${hasShippedEvidence} as has_shipped_evidence
        from ${issues}
        where ${issues.projectId} = ${projectId}
      ) evidence_per_issue
      group by status, has_shipped_evidence
    `);

    const byStatus = emptyByStatus();
    let shipped = 0;
    let closedUnshipped = 0;
    let inFlight = 0;
    let remaining = 0;
    for (const row of rows) {
      const status = row.status;
      const count = Number(row.count);
      byStatus[status] += count;
      const bucket = bucketOf(status, row.has_shipped_evidence);
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
    // cm:why ISS-817 — "released to production" overclaimed: this bucket also holds issues merged to the base branch and closed by hand, which have shipped code but no production release
    `- shipped (code reached the release branch): ${p.shipped}`,
    `- closed with no recorded release (duplicate, merged elsewhere, decided not to do — or shipped without a matching record): ${p.closedUnshipped}`,
    `- in progress: ${p.inFlight}`,
    `- not started: ${p.remaining}`,
    `- total: ${p.total}`,
  ].join('\n');
}
