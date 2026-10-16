/**
 * ISS-1122 — no issue rests in a non-terminal status with nothing working it.
 *
 * The kernel keeps this invariant on runs and jobs, in both directions. On the entity a person
 * reads off the board it was kept by nobody: `stranded-issues.ts` watches `waiting` and
 * merged-and-stranded, `issue-run-invariant.ts` watches three statuses, and between them most of a
 * board went unread, and all three only ever emitted a notification.
 *
 * This pass has two arms. One reads every non-terminal status that is not declared at rest, writes
 * what it found onto the row itself, and releases a lease that has lapsed by its own terms. The
 * other clears a finding that has stopped holding, so a recovered row stops claiming to be stuck.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ADMITTED_RUNNER } from '../devices/pool-admission.js';
import { statusLabel } from '../issues/status-sets.js';
import { elapsedWords } from '../lib/elapsed-words.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
import { resolveNotifications } from '../notifications/auto-resolve.js';
import { emitNotification } from '../notifications/emit.js';
import { sweepGroup } from '../notifications/explanations.js';
import { projectAdminUserIdsFor } from '../notifications/project-admins.js';
import { resolveArchivedProjectNotices } from './archived-project-notices.js';
import {
  type CandidateRow,
  IDLE_KEY_SUFFIX,
  IDLE_SCAN_LIMIT,
  NOTHING_LIVE_ON_THIS_ISSUE,
  readCandidates,
  strandResolutionKey,
} from './idle-candidates.js';
import { holderFanout, readClaim } from './lease-fanout.js';
import { readReleaseHold } from './release-hold.js';
import {
  type LeaseReading,
  leaseHolderOf,
  leaseIsReleasable,
  leaseIsWorkInProgress,
  leaseShowsHolderGone,
} from './session-claim.js';
import {
  heldReleaseWait,
  type StrandEvidence,
  strandReason,
  strandRuleFor,
} from './strand-rules.js';
import { advanceSweep, sweepWindow } from './sweep-cursor.js';

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
  /** Delivered notices resolved because the row no longer carries the finding they were raised on. */
  resolved: number;
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
  evidence: { merged: boolean; everRan: boolean; poolHasRunner: boolean; leaseFanout: number };
}

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
    resolved: 0,
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
    if (stands) result.reported += await surface({ row, record: judged.record, admins, now });
  }

  result.cleared = await clearRecovered(now, scope);
  result.resolved = await resolveClearedNotices(scope);
  await resolveArchivedProjectNotices(IDLE_KEY_SUFFIX);
  return result;
}

/**
 * Whether the finding already on the row says the same thing as the one just built.
 *
 * `at` is the only field that moves on its own, and it is what makes the record say how long the
 * row has been reported rather than how long ago the last tick was — so an unchanged finding is
 * left exactly as it was written.
 */
function unchangedStrand(held: unknown, next: StrandRecord): boolean {
  if (held === null || typeof held !== 'object') return false;
  const { at: _next, ...rest } = next;
  const { at: _held, ...heldRest } = held as StrandRecord;
  return canonical(heldRest) === canonical(rest);
}

/** Key order, which `jsonb` normalises on the way in and an object literal does not. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
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

  const evidence: StrandEvidence = {
    merged: row.merged_at !== null,
    everRan: row.ever_ran,
    poolHasRunner: pooled.has(row.project_id),
    lease,
    releaseHold: readReleaseHold(row.release_hold),
  };
  const { reason, owes } = strandReason({ status: row.status, rule, evidence });
  const waitingFor =
    heldReleaseWait(row.status, evidence.releaseHold)?.waitingFor ?? rule.waitingFor;
  return {
    lease,
    unclassified: false,
    record: {
      at: now.toISOString(),
      status: row.status,
      since: row.entered_at,
      waitingFor,
      owes,
      reason,
      lease: lease.verdict,
      evidence: {
        merged: evidence.merged,
        everRan: evidence.everRan,
        poolHasRunner: evidence.poolHasRunner,
        leaseFanout: lease.fanout,
      },
    },
  };
}

function unclassifiedRecord(row: CandidateRow, lease: LeaseReading, now: Date): StrandRecord {
  return {
    at: now.toISOString(),
    status: row.status,
    since: row.entered_at,
    waitingFor: 'not decidable: this status is in no rule this build holds',
    owes: 'human',
    reason: `the status ${statusLabel(row.status)} is not one this build classifies, so no clock and no owner apply to it`,
    lease: lease.verdict,
    evidence: {
      merged: row.merged_at !== null,
      everRan: row.ever_ran,
      poolHasRunner: false,
      leaseFanout: lease.fanout,
    },
  };
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
       AND ${ADMITTED_RUNNER}
  `)) as unknown as Array<{ project_id: string }>;
  return new Set(rows.map((r) => r.project_id));
}

/**
 * Write the finding onto the row, and release the lease where it has lapsed.
 *
 * Guarded on the lease value that was read, so a claim landing between the read and the write wins
 * and this pass skips the row; and written through `jsonb_set` on named keys, so another key of
 * `session_context` written concurrently survives. `updated_at` is deliberately absent from the
 * SET clause: it has no database trigger, and a swept row must not read as freshly worked.
 */
async function writeStrand(args: {
  row: CandidateRow;
  record: StrandRecord;
  release: boolean;
  now: Date;
}): Promise<boolean> {
  const { row, record, release, now } = args;
  const base = sql`jsonb_set(coalesce(i.session_context, '{}'::jsonb), '{strand}', ${JSON.stringify(record)}::jsonb, true)`;
  const entry = JSON.stringify({
    at: now.toISOString(),
    how: 'swept',
    holder: leaseHolderOf(row.lease),
    status: row.status,
  });
  const next = release
    ? sql`jsonb_set(
          jsonb_set(${base}, '{lease,stopped}', to_jsonb(${now.toISOString()}::text), true),
          '{lease,history}',
          (CASE WHEN jsonb_typeof(i.session_context -> 'lease' -> 'history') = 'array'
                THEN i.session_context -> 'lease' -> 'history'
                ELSE '[]'::jsonb END) || ${entry}::jsonb,
          true)`
    : base;

  const read = row.lease === null || row.lease === undefined ? null : JSON.stringify(row.lease);
  const written = (await db.execute(sql`
    UPDATE issues i
       SET session_context = ${next}
     WHERE i.id = ${row.id}
       AND coalesce(i.session_context -> 'lease', 'null'::jsonb)
           IS NOT DISTINCT FROM coalesce(${read}::jsonb, 'null'::jsonb)
    RETURNING i.id
  `)) as unknown as Array<{ id: string }>;

  if (written.length === 0) {
    logger.info(
      { issueId: row.id },
      'idle-issues: the lease moved between the read and the write — the row is left as the other writer left it',
    );
    return false;
  }
  return true;
}

/**
 * Clear a finding that has stopped holding.
 *
 * Without it the first strand a row is given is the last thing it ever says about itself, and a
 * recovered issue goes on claiming to be stuck — the same defect this pass exists to close, written
 * by the pass itself.
 */
async function clearRecovered(now: Date, scope: { projectId?: string }): Promise<number> {
  const scoped = scope.projectId ? sql`AND i.project_id = ${scope.projectId}` : sql``;
  // This arm writes only to the rows it clears, so a page full of rows that are STILL stranded
  // would be re-read every tick and hide every row behind them for ever. The cursor is what walks
  // past them; it resumes after the last row read and wraps when a page comes back short.
  const cursorKey = `idle-recovered:${scope.projectId ?? '*'}`;
  const window = sweepWindow(cursorKey, now.toISOString());
  const resume = window.after
    ? sql`AND (i.updated_at, i.id) > (${window.after.ts}::timestamptz, ${window.after.id}::uuid)`
    : sql``;
  const rows = (await db.execute(sql`
    SELECT i.id, i.status, i.updated_at,
           i.updated_at::text AS cursor_ts,
           i.session_context -> 'lease'  AS lease,
           i.session_context -> 'strand' AS strand,
           (${NOTHING_LIVE_ON_THIS_ISSUE}) AS nothing_running
      FROM issues i
     WHERE i.session_context ? 'strand'
       AND i.updated_at <= ${window.until}::timestamptz
       ${scoped}
       ${resume}
     ORDER BY i.updated_at ASC, i.id ASC
     LIMIT ${IDLE_SCAN_LIMIT}
  `)) as unknown as Array<{
    id: string;
    status: string;
    updated_at: string;
    cursor_ts: string;
    lease: unknown;
    strand: unknown;
    nothing_running: boolean;
  }>;
  const lastRow = rows.at(-1);
  advanceSweep(
    cursorKey,
    window,
    lastRow ? { ts: lastRow.cursor_ts, id: lastRow.id } : null,
    rows.length === IDLE_SCAN_LIMIT,
  );
  if (rows.length === 0) return 0;

  const fanout = await holderFanout(
    rows.map((r) => r.lease),
    now,
  );
  let cleared = 0;
  for (const row of rows) {
    if (stillStranded(row, now, fanout)) continue;
    const held =
      row.strand === null || row.strand === undefined ? null : JSON.stringify(row.strand);
    const done = (await db.execute(sql`
      UPDATE issues i
         SET session_context = i.session_context - 'strand'
       WHERE i.id = ${row.id}
         AND coalesce(i.session_context -> 'strand', 'null'::jsonb)
             IS NOT DISTINCT FROM coalesce(${held}::jsonb, 'null'::jsonb)
      RETURNING i.id
    `)) as unknown as Array<{ id: string }>;
    if (done.length > 0) cleared += 1;
  }
  if (cleared > 0) logger.info({ cleared }, 'idle-issues: findings cleared on rows that recovered');
  return cleared;
}

/**
 * A notice stands only while its row carries the finding it was raised on. Clearing the finding is
 * where this pass decides a row recovered, so that is where its notice ends, whichever way it
 * recovered; read by notice rather than by the cleared page, so one cleared before this ran ends too.
 */
async function resolveClearedNotices(scope: { projectId?: string }): Promise<number> {
  const scoped = scope.projectId ? sql`AND i.project_id = ${scope.projectId}` : sql``;
  const rows = (await db.execute(sql`
    SELECT DISTINCT n.resolution_key AS "key"
      FROM notifications n
      JOIN issues i ON i.id = n.issue_id
     WHERE n.type = 'issue_stranded'
       AND n.resolved_at IS NULL
       AND n.state IN ('firing', 'inhibited')
       AND n.resolution_key LIKE ${`issue:%${IDLE_KEY_SUFFIX}`}
       AND NOT (coalesce(i.session_context, '{}'::jsonb) ? 'strand')
       ${scoped}
  `)) as unknown as Array<{ key: string }>;
  let resolved = 0;
  for (const { key } of rows) resolved += await resolveNotifications(key);
  return resolved;
}

function stillStranded(
  row: {
    status: string;
    updated_at: string;
    lease: unknown;
    strand: unknown;
    nothing_running: boolean;
  },
  now: Date,
  fanout: ReadonlyMap<string, number>,
): boolean {
  if (!row.nothing_running) return false;
  const rule = strandRuleFor(row.status);
  if (rule !== null && !rule.watch) return false;
  const lease = readClaim(row.lease, now, fanout);
  // A row that has MOVED carries a finding written at the status it left, whose new clock has not
  // run out; holding the old finding through it shows progress as a standing failure. Asked of a
  // row standing still, or of one whose holder is gone, it reads progress that never happened.
  if (
    hasMoved(row.status, row.strand) &&
    !leaseShowsHolderGone(lease.verdict) &&
    rule?.watch &&
    !graceSpent(row.updated_at, rule.graceMs, now)
  ) {
    return false;
  }
  return !leaseIsWorkInProgress(lease.verdict);
}

/** Left the status its finding was written at; unreadable reads as moved, as this arm did before. */
function hasMoved(status: string, strand: unknown): boolean {
  if (strand === null || typeof strand !== 'object' || Array.isArray(strand)) return true;
  const written = (strand as Record<string, unknown>).status;
  return typeof written !== 'string' || written !== status;
}

/** Whether a row has stood at its status long enough for that status's own clock to say anything. */
function graceSpent(updatedAt: string, graceMs: number, now: Date): boolean {
  return now.getTime() - Date.parse(updatedAt) >= graceMs;
}

/** A reason as a sentence of its own: opened by a capital, closed by one full stop (a release hold's reason already ends in its own). */
function asSentence(reason: string): string {
  const text = reason.trimEnd();
  const opened = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(opened) ? opened : `${opened}.`;
}

/**
 * What a project's admins read about one idle issue: the issue with its project, the status in the
 * screen's word, and how long it has stood there, never the stored time a raw query hands back.
 * `shared` and `malformed` are the two readings the classifier refuses to draw a conclusion from,
 * so the headline may not draw one either: what was established there is that no live work could
 * be confirmed, which is a different sentence from nobody working it.
 */
export function idleNotice(args: {
  ref: string;
  projectName: string;
  record: Pick<StrandRecord, 'status' | 'since' | 'reason' | 'waitingFor' | 'owes' | 'lease'>;
  now: Date;
}): { title: string; body: string } {
  const { ref, projectName, record, now } = args;
  const label = statusLabel(record.status);
  const age = elapsedWords(record.since, now);
  const unconfirmed = record.lease === 'shared' || record.lease === 'malformed';
  const title = unconfirmed
    ? `${ref} reads ${label} and no live work could be confirmed — ${projectName}`
    : `${ref} reads ${label} and nothing is working it — ${projectName}`;
  const opening = unconfirmed
    ? `${ref} has read ${label} for ${age} with no live job or run behind it, and a lease that establishes nothing either way.`
    : `${ref} has read ${label} for ${age} with no live job, run or lease behind it.`;
  return {
    title,
    body:
      `${opening} ${asSentence(record.reason)} ` +
      `It is waiting for ${record.waitingFor}, and ${record.owes === 'human' ? 'a person' : 'an agent'} owes the next move.`,
  };
}

async function surface(args: {
  row: CandidateRow;
  record: StrandRecord;
  admins: ReadonlyMap<string, string[]>;
  now: Date;
}): Promise<number> {
  const { row, record, admins, now } = args;
  const recipients = admins.get(row.project_id) ?? [];
  if (recipients.length === 0) return 0;
  const ref = formatIssueRef(row.issue_prefix, row.iss_seq);
  const sent = await emitNotification(
    {
      recipients,
      projectId: row.project_id,
      issueId: row.id,
      type: 'issue_stranded',
      resolutionKey: strandResolutionKey(row.id),
      ...sweepGroup('idle-issues', now),
      ...idleNotice({ ref, projectName: row.project_name, record, now }),
    },
    now,
  );
  return sent?.delivered ?? 0;
}
