/**
 * ISS-1122 — no issue rests in a non-terminal status with nothing working it.
 *
 * The kernel keeps this invariant on runs and jobs, in both directions. On the entity a person
 * reads off the board it was kept by nobody: `stranded-issues.ts` watches decision parks and
 * merged-and-stranded, `issue-run-invariant.ts` watches three statuses, and between them most of a
 * board went unread — and all three only ever emitted a notification, so a row they did see stayed
 * exactly where it was.
 *
 * This pass has two arms. One reads every non-terminal status that is not declared at rest, writes
 * what it found onto the row itself, and releases a lease that has lapsed by its own terms. The
 * other clears a finding that has stopped holding, so a recovered row stops claiming to be stuck.
 */

import type { ReleaseHoldView } from '@forge/contracts/releases';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueStatuses } from '../db/schema.js';
import type { WorkStep } from '../db/schema-issue-work-state.js';
import {
  contractWaitUnsettledSql,
  designUnapprovedSql,
  heldReleaseWait,
  holderFanout,
  holdingBlockerSeqsSql,
  type LeaseReading,
  landedWait,
  leaseIsReleasable,
  leaseIsWorkInProgress,
  leaseShowsHolderGone,
  patternReviewPendingSql,
  readClaim,
  SHORTEST_GRACE_MS,
  STRAND_RULES,
  type StrandEvidence,
  type StrandWithheld,
  strandReason,
  strandRuleFor,
  withheldWait,
} from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../lib/logger.js';
import {
  clearRecovered,
  graceSpent,
  IDLE_SCAN_LIMIT,
  NOTHING_LIVE_ON_THIS_ISSUE,
} from './idle-recovered.js';
import { surface, unchangedStrand, writeStrand } from './idle-strand-write.js';
import { admittedRunner, projectAdminUserIdsFor } from './ports.js';
import { isTerminalPlacement } from './status-assertions.js';
import { advanceSweep, type SweepPosition, sweepWindow } from './sweep-cursor.js';

type ReleaseHold = Omit<ReleaseHoldView, 'heldAt'>;

export interface IdleIssuesResult {
  /** Rows read as stranded this pass. */
  detected: number;
  /** People newly told about one, summed over the rows. */
  reported: number;
  /** Lapsed leases released. */
  leasesReleased: number;
  /** Findings cleared because the row is no longer stranded. */
  cleared: number;
  /** Rows whose status the rule table does not hold. */
  unclassified: number;
}

/** What this pass writes onto the row, at `session_context.strand`. */
export interface StrandRecord {
  at: string;
  status: string;
  since: string;
  waitingFor: string;
  owes: string;
  reason: string;
  lease: string;
  evidence: {
    merged: boolean;
    everRan: boolean;
    poolHasRunner: boolean;
    leaseFanout: number;
    /** What withholds it from dispatch, where anything does. */
    withheld?: StrandWithheld;
  };
}

export interface CandidateRow {
  id: string;
  project_id: string;
  iss_seq: number;
  issue_prefix: string | null;
  project_name: string;
  status: string;
  title: string;
  /** Text, not a `Date`: `db.execute` hands raw SQL results back unparsed. */
  updated_at: string;
  merged_at: string | null;
  step: WorkStep | null;
  lease: unknown;
  strand: unknown;
  /** The standing `release_holds` row, built from its NOT NULL columns. */
  release_hold: ReleaseHold | null;
  ever_ran: boolean;
  /** `iss_seq` of each blocker whose live `blocks` edge holds the row. */
  held_by: number[];
  design_unapproved: boolean;
  contract_unsettled: boolean;
  pattern_pending: boolean;
  cursor_ts: string;
}

/** Terminal, plus every status the rule table declares at rest. Everything else is a candidate. */
const NOT_WATCHED: readonly string[] = issueStatuses.filter(
  (s) => isTerminalPlacement(s) || !STRAND_RULES[s].watch,
);

/**
 * One pass of the issue-level invariant.
 *
 * It does NOT catch its own failures, which is where it parts from the three passes beside it.
 * Each of those returns a zeroed result on a throw, so a broken pass and a clean board are the
 * same two numbers — the shape this issue exists to refuse. `runPipelineSweep`'s `runPass` already
 * isolates a throw from the other passes, logs it, captures it and re-throws the first at the end
 * of the tick, so nothing is lost by letting one out.
 */
export async function reconcileIdleIssues(
  now: Date = new Date(),
  scope: { projectId?: string } = {},
): Promise<IdleIssuesResult> {
  const rows = await readCandidates(now, scope);
  const fanout = await holderFanout(
    rows.map((r) => r.lease),
    now,
  );
  const pooled = await projectsWithAdmittedRunner(rows.map((r) => r.project_id));
  const admins = await projectAdminUserIdsFor(rows.map((r) => r.project_id));

  const result: IdleIssuesResult = {
    detected: 0,
    reported: 0,
    leasesReleased: 0,
    cleared: 0,
    unclassified: 0,
  };
  for (const row of rows) {
    const judged = judge(row, now, fanout, pooled);
    if (judged === null) continue;
    result.detected += 1;
    if (judged.unclassified) result.unclassified += 1;

    // The row already saying this is a reason not to write it again, never a reason to go quiet:
    // the condition behind the notification is re-derived from what is still being emitted, so a
    // pass that stopped emitting would let an alert resolve under a row that is still stranded.
    const release = leaseIsReleasable(judged.lease);
    const rewrite = release || !unchangedStrand(row.strand, judged.record);
    const stands = rewrite ? await writeStrand({ row, record: judged.record, release, now }) : true;
    if (stands && release) result.leasesReleased += 1;
    // a withheld row waits on what withholds it, which the sweep reads on its own row: nobody is
    // told this one is stranded, while the finding on it still names what it waits on
    if (stands && judged.record.owes !== 'blocker') {
      result.reported += await surface({ row, record: judged.record, admins });
    }
  }

  result.cleared = await clearRecovered(now, scope);
  return result;
}

/** Whether this row is stranded, and what to write on it if it is. */
function judge(
  row: CandidateRow,
  now: Date,
  fanout: ReadonlyMap<string, number>,
  pooled: ReadonlySet<string>,
): { record: StrandRecord; lease: LeaseReading; unclassified: boolean } | null {
  const lease = readClaim(row.lease, now, fanout);
  if (leaseIsWorkInProgress(lease.verdict)) return null;

  const rule = strandRuleFor(row.status);
  const ref = formatIssueRef(row.issue_prefix, row.iss_seq);
  if (rule === null) {
    logger.error(
      { issue: ref, projectId: row.project_id, status: row.status },
      'idle-issues: this row holds a status the rule table does not classify — it is counted, not dropped',
    );
    return {
      lease,
      unclassified: true,
      record: unclassifiedRecord(row, lease, now),
    };
  }
  if (!rule.watch) return null;
  // At `in_progress` the two hours run from the holder's last write, so the grace, not the lease
  // term, decides when a dead run's row is reached — and waiting it out buys the reading nothing.
  if (!leaseShowsHolderGone(lease.verdict) && !graceSpent(row.updated_at, rule.graceMs, now)) {
    return null;
  }

  const withheld = withheldOf(row);
  const evidence: StrandEvidence = {
    merged: row.merged_at !== null,
    everRan: row.ever_ran,
    poolHasRunner: pooled.has(row.project_id),
    lease,
    releaseHold: row.release_hold,
    step: row.step,
    withheld,
  };
  const { reason, owes } = strandReason({ status: row.status, rule, evidence });
  const waitingFor =
    heldReleaseWait(row.status, evidence.releaseHold)?.waitingFor ??
    landedWait(row.status, evidence)?.waitingFor ??
    (owes === 'blocker' ? withheldWait(row.status, withheld)?.waitingFor : undefined) ??
    rule.waitingFor;
  return {
    lease,
    unclassified: false,
    record: {
      at: now.toISOString(),
      status: row.status,
      since: row.updated_at,
      waitingFor,
      owes,
      reason,
      lease: lease.verdict,
      evidence: {
        merged: evidence.merged,
        everRan: evidence.everRan,
        poolHasRunner: evidence.poolHasRunner,
        leaseFanout: lease.fanout,
        ...(withheld ? { withheld } : {}),
      },
    },
  };
}

/** What withholds the row from dispatch, as the candidate read took it; null where nothing does. */
function withheldOf(row: CandidateRow): StrandWithheld | null {
  const blockers = (row.held_by ?? []).map((seq) => formatIssueRef(row.issue_prefix, seq));
  if (
    blockers.length === 0 &&
    !row.design_unapproved &&
    !row.contract_unsettled &&
    !row.pattern_pending
  ) {
    return null;
  }
  return {
    blockers,
    design: row.design_unapproved,
    contract: row.contract_unsettled,
    pattern: row.pattern_pending,
  };
}

function unclassifiedRecord(row: CandidateRow, lease: LeaseReading, now: Date): StrandRecord {
  return {
    at: now.toISOString(),
    status: row.status,
    since: row.updated_at,
    waitingFor: 'not decidable: this status is in no rule this build holds',
    owes: 'human',
    reason: `the status \`${row.status}\` is not one this build classifies, so no clock and no owner apply to it`,
    lease: lease.verdict,
    evidence: {
      merged: row.merged_at !== null,
      everRan: row.ever_ran,
      poolHasRunner: false,
      leaseFanout: lease.fanout,
    },
  };
}

async function readCandidates(now: Date, scope: { projectId?: string }): Promise<CandidateRow[]> {
  const cursorKey = `idle-issues:${scope.projectId ?? '*'}`;
  const until = new Date(now.getTime() - SHORTEST_GRACE_MS).toISOString();
  const window = sweepWindow(cursorKey, until);

  // NOT IN, never IN: `issues.status` is a text column, so a value this build's enum has not caught
  // up with must reach TypeScript to be named rather than be filtered out here.
  const excluded = sql.join(
    NOT_WATCHED.map((s) => sql`${s}`),
    sql`, `,
  );
  const after = window.after;
  const scoped = scope.projectId ? sql`AND i.project_id = ${scope.projectId}` : sql``;
  const resume = after
    ? sql`AND (i.updated_at, i.id) > (${after.ts}::timestamptz, ${after.id}::uuid)`
    : sql``;

  const rows = (await db.execute(sql`
    SELECT i.id, i.project_id, i.iss_seq, i.status, i.title, i.updated_at, i.merged_at,
           p.issue_prefix, p.name AS project_name,
           (SELECT w.lease FROM issue_work_state w WHERE w.issue_id = i.id)  AS lease,
           (SELECT w.step FROM issue_work_state w WHERE w.issue_id = i.id)   AS step,
           i.session_context -> 'strand' AS strand,
           (SELECT jsonb_build_object('code', h.code, 'reason', h.reason, 'owes', h.owes,
                                      'waitingFor', h.waiting_for)
              FROM release_holds h
             WHERE h.issue_id = i.id AND h.cleared_at IS NULL) AS release_hold,
           i.updated_at::text AS cursor_ts,
           EXISTS (SELECT 1 FROM pipeline_runs pr WHERE pr.issue_id = i.id) AS ever_ran,
           -- the admissible list's own withholding predicates (devices/admissible.ts), so the
           -- finding never says a dispatch is missing on a row no dispatch would be handed
           ${holdingBlockerSeqsSql({ issueId: sql`i.id`, projectId: sql`i.project_id` })} AS held_by,
           ${designUnapprovedSql(sql`i.id`)} AS design_unapproved,
           ${contractWaitUnsettledSql(sql`i.id`)} AS contract_unsettled,
           ${patternReviewPendingSql(sql`i.id`)} AS pattern_pending
      FROM issues i
      JOIN projects p ON p.id = i.project_id
     WHERE i.status NOT IN (${excluded})
       AND i.updated_at < ${window.until}::timestamptz
       AND ${NOTHING_LIVE_ON_THIS_ISSUE}
       ${scoped}
       ${resume}
     ORDER BY i.updated_at ASC, i.id ASC
     LIMIT ${IDLE_SCAN_LIMIT}
  `)) as unknown as CandidateRow[];

  const filled = rows.length === IDLE_SCAN_LIMIT;
  const lastRow = rows.at(-1);
  const last: SweepPosition | null = lastRow ? { ts: lastRow.cursor_ts, id: lastRow.id } : null;
  advanceSweep(cursorKey, window, last, filled);
  if (filled) {
    logger.warn(
      { limit: IDLE_SCAN_LIMIT, resumesAfter: last?.ts ?? null },
      'idle-issues: the scan filled its page — the rest is read on later passes',
    );
  }
  return rows;
}

/** Which of these projects has a runner the job pool would admit — that module's own predicate. */
async function projectsWithAdmittedRunner(
  projectIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return new Set();
  const rows = (await db.execute(sql`
    SELECT DISTINCT r.project_id
      FROM runners r
     WHERE r.project_id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND ${admittedRunner()}
  `)) as unknown as Array<{ project_id: string }>;
  return new Set(rows.map((r) => r.project_id));
}
