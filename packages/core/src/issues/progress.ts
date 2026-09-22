import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { activityLog, type IssueStatus, issueStatuses, issues } from '../db/schema.js';
import { logger } from '../logger.js';
import { BASE_MERGE_STATE } from './merged-at.js';

export type ProgressBucket = 'shipped' | 'closed_unshipped' | 'in_flight' | 'remaining';

export interface ProjectProgress {
  /** Released, or closed with evidence the code actually shipped. */
  shipped: number;
  closedUnshipped: number;
  inFlight: number;
  remaining: number;
  total: number;
  byStatus: Record<IssueStatus, number>;
  computedAt: Date;
}

const REMAINING_STATUSES = new Set<IssueStatus>(['draft', 'waiting', 'needs_info', 'on_hold']);

/**
 * ISS-1108 — `closed` without shipped evidence is HISTORICAL from 0304 onward. A `closed` row
 * written after that migration always carries `merged_at`, so the only `closed` issues this can
 * still bucket as `closed_unshipped` are ones closed before the rule, plus `dropped`, which is
 * where non-work goes now and has never carried a claim. It is not a rule still in force.
 */
export function bucketOf(status: IssueStatus, hasShippedEvidence: boolean): ProgressBucket {
  if (status === 'awaiting_release' || (status === 'closed' && hasShippedEvidence))
    return 'shipped';
  if (status === 'closed' || status === 'dropped') return 'closed_unshipped';
  if (REMAINING_STATUSES.has(status)) return 'remaining';
  return 'in_flight';
}

function emptyByStatus(): Record<IssueStatus, number> {
  return Object.fromEntries(issueStatuses.map((s) => [s, 0])) as Record<IssueStatus, number>;
}

/** The pool, or a caller's open transaction — this is one read and it must join the caller's. */
export type ProgressReader = Pick<typeof defaultDb, 'execute'>;

export async function computeProjectProgress(
  projectId: string,
  dbi: ProgressReader = defaultDb,
): Promise<ProjectProgress | null> {
  try {
    const leftMergeState = sql`exists (
      select 1 from ${activityLog}
      where ${activityLog.issueId} = ${issues.id}
        and ${activityLog.action} = 'issue.statusChanged'
        and ${activityLog.payload}->>'to' = ${BASE_MERGE_STATE}
    )`;

    // ISS-1108 — HISTORICAL, and kept for exactly that. The close stopped stamping `merged_at`,
    // so nothing can produce this shape any more; every row it still matches was closed before
    // 0304. Delete it once no `issues` row predates that migration.
    const stampedByCloseItself = sql`exists (
      select 1 from ${activityLog}
      where ${activityLog.issueId} = ${issues.id}
        and ${activityLog.action} = 'issue.statusChanged'
        and ${activityLog.payload}->>'to' = 'closed'
        and ${activityLog.createdAt} = ${issues.mergedAt}
    )`;

    const hasShippedEvidence = sql<boolean>`(${leftMergeState} or (${issues.mergedAt} is not null and not ${stampedByCloseItself}))`;

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
    `- shipped (code reached the release branch): ${p.shipped}`,
    `- closed with no recorded release (duplicate, merged elsewhere, decided not to do — or shipped without a matching record): ${p.closedUnshipped}`,
    `- in progress: ${p.inFlight}`,
    `- not started: ${p.remaining}`,
    `- total: ${p.total}`,
  ].join('\n');
}
