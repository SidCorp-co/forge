/**
 * ISS-1027 — the nightly sweep that enforces `policy.ts`.
 *
 * One pass per stated rule, each a bounded batch loop that stops on a short
 * batch, and one report per table per tick: what the window resolved to, how
 * many rows went, how many the rule held back, and how long it took. The
 * held-back figure is the half that makes the deleted one readable — a table
 * reporting `deleted: 0` is either swept clean or wedged, and only the second
 * number tells them apart.
 *
 * Then the repair pass. A `job_events` row is removable only once the transcript
 * it would rebuild is recorded as finalised, so a session whose finalisation
 * never happened would hold its events for ever. It is not expired: the events
 * are still there, so the rebuild is exactly the record ISS-1027 says must
 * survive, and the sweep derives it. The bound stops one tick rebuilding a whole
 * backlog; spending it least-recently-attempted first stops a session that keeps
 * failing from holding that bound for ever.
 */

import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentSessions } from '../../db/schema.js';
import { TRANSCRIPT_FINALIZED_KEY } from '../../db/transcript-marker.js';
import { deriveSessionFinal } from '../../jobs/session-transcript.js';
import { logger } from '../../logger.js';
import { boss } from '../../queue/boss.js';
import {
  finalizeRepairMax,
  RETENTION_RULES,
  type RetentionRule,
  resolveRetention,
} from './policy.js';
import {
  RETENTION_STATEMENTS,
  repairCandidates,
  stampFinalizeAttempt,
  truncatedHistories,
} from './statements.js';

// cm:why the queue name still says `job-event-retention` although this sweep now covers six tables: the string is pg-boss's SCHEDULE key, and renaming it leaves the old queue's cron row in the database with no worker attached to it — a job enqueued nightly for ever that nothing runs. The name is stale; a stranded schedule is a leak.
export const RETENTION_QUEUE = 'job-event-retention';

const BATCH_SIZE = 10_000;
/** Cap the loop defensively so a statement that never shortens cannot spin. */
const MAX_BATCHES = 1000;
/** How many held sessions a tick names in the log before it stops listing them. */
const NAMED_HELD_SESSIONS = 20;

// cm:guard this exists so a test can reach the batch cap, which is otherwise ten million rows away, and reaching it is the only way to prove `heldBack` counts what a rule exempts rather than what a tick failed to drain. It is NOT an operator knob: the scheduled worker passes nothing and there is no environment variable behind it, so the production shape is the two constants above and stays readable in one place.
/** The batch shape the delete loop runs at. */
export interface SweepBounds {
  batchSize: number;
  maxBatches: number;
}

/** What one table's rule did this tick. */
export interface TableSweepResult {
  table: string;
  /** The window this tick swept at, or null where the rule sweeps nothing. */
  windowDays: number | null;
  deleted: number;
  /**
   * Over-age rows this table's rule EXEMPTS — a running job's audit, a runner's
   * carry-in event, a transcript not yet finalised. It counts the negation of
   * the delete's own predicate, so it says nothing about a backlog the batch cap
   * left behind; `capped` says that.
   */
  heldBack: number;
  durationMs: number;
  /** An environment override this tick refused, and why. */
  rejected: string | null;
  /**
   * The batch loop hit its cap with a full batch still coming back, so eligible
   * rows are left over — rows this rule would have deleted and did not reach.
   * They are NOT in `heldBack`, and keeping the two apart is the point: one is a
   * sweep that ran out of budget, the other is a rule doing its job, and a
   * single number that moves for either reason tells an operator nothing.
   */
  capped: boolean;
}

/** What the finalise-repair pass did this tick. */
export interface RepairSweepResult {
  attempted: number;
  finalized: number;
  /** Sessions that were attempted and still carry no finalisation. */
  stillUnfinalized: string[];
  /**
   * Sessions this pass refused to touch: over-age, unmarked, and holding only a
   * suffix of their job's events, so a rebuild would replace a stored
   * transcript with a shorter one. Their events stay and a person decides.
   */
  withTruncatedHistory: string[];
}

export interface RetentionSweepResult {
  durationMs: number;
  deleted: number;
  tables: TableSweepResult[];
  repair: RepairSweepResult;
}

async function countRows(statement: ReturnType<typeof sql>): Promise<number> {
  const rows = (await db.execute(statement)) as unknown;
  return Array.isArray(rows) ? rows.length : 0;
}

async function readCount(statement: ReturnType<typeof sql>): Promise<number> {
  const rows = (await db.execute<{ n: number }>(statement)) as unknown as Array<{ n: number }>;
  return Array.isArray(rows) && rows[0] ? Number(rows[0].n) : 0;
}

async function sweepTable(rule: RetentionRule, bounds: SweepBounds): Promise<TableSweepResult> {
  const t0 = Date.now();
  const resolved = resolveRetention(rule);
  const base: TableSweepResult = {
    table: rule.table,
    windowDays: resolved.days,
    deleted: 0,
    heldBack: 0,
    durationMs: 0,
    rejected: resolved.rejected,
    capped: false,
  };
  if (resolved.rejected) {
    logger.warn(
      { table: rule.table, rejected: resolved.rejected },
      'retention: environment override refused',
    );
  }
  const statements = RETENTION_STATEMENTS[rule.table];
  if (resolved.days === null || !statements) {
    return { ...base, durationMs: Date.now() - t0 };
  }

  let deleted = 0;
  let capped = true;
  for (let i = 0; i < bounds.maxBatches; i++) {
    const batch = await countRows(statements.deleteBatch(resolved.days, bounds.batchSize));
    deleted += batch;
    if (batch < bounds.batchSize) {
      capped = false;
      break;
    }
  }
  if (capped) {
    logger.warn(
      { table: rule.table, deleted, batches: bounds.maxBatches },
      'retention: the batch cap stopped this table before it ran out of rows — eligible rows are left for the next tick',
    );
  }
  const heldBack = statements.heldBack ? await readCount(statements.heldBack(resolved.days)) : 0;
  return { ...base, deleted, heldBack, capped, durationMs: Date.now() - t0 };
}

type Candidate = { job_id: string; session_id: string };

/**
 * Finalise the transcripts standing between over-age events and their deletion.
 * The attempt is stamped BEFORE the derive, so a session that throws — or that
 * takes the process down mid-derive — rotates behind the ones not yet tried.
 */
async function repairUnfinalized(days: number, max: number): Promise<RepairSweepResult> {
  const truncated = (await db.execute<{ session_id: string }>(
    truncatedHistories(days, NAMED_HELD_SESSIONS),
  )) as unknown as Array<{ session_id: string }>;
  const withTruncatedHistory = Array.isArray(truncated) ? truncated.map((r) => r.session_id) : [];
  const none = { attempted: 0, finalized: 0, stillUnfinalized: [], withTruncatedHistory };
  if (max <= 0) return none;
  const rows = (await db.execute<Candidate>(repairCandidates(days, max))) as unknown as Candidate[];
  if (!Array.isArray(rows) || rows.length === 0) return none;

  const now = new Date();
  for (const row of rows) {
    try {
      await db.execute(stampFinalizeAttempt(row.session_id, now));
      await deriveSessionFinal(row.job_id, row.session_id);
    } catch (err) {
      logger.warn(
        { err, jobId: row.job_id, agentSessionId: row.session_id },
        'retention: finalise repair threw for one session (the rest still run)',
      );
    }
  }

  const ids = rows.map((r) => r.session_id);
  const done = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        inArray(agentSessions.id, ids),
        sql`${agentSessions.metadata} ->> ${TRANSCRIPT_FINALIZED_KEY} IS NOT NULL`,
      ),
    );
  const finalizedIds = new Set(done.map((r) => r.id));
  return {
    attempted: ids.length,
    finalized: finalizedIds.size,
    stillUnfinalized: ids.filter((id) => !finalizedIds.has(id)),
    withTruncatedHistory,
  };
}

export async function runRetentionSweep(
  bounds: Partial<SweepBounds> = {},
): Promise<RetentionSweepResult> {
  const t0 = Date.now();
  const limits: SweepBounds = {
    batchSize: bounds.batchSize ?? BATCH_SIZE,
    maxBatches: bounds.maxBatches ?? MAX_BATCHES,
  };
  const tables: TableSweepResult[] = [];
  for (const rule of RETENTION_RULES) {
    const result = await sweepTable(rule, limits);
    tables.push(result);
    logger.info(result, `retention: ${rule.table}`);
  }

  const jobEvents = tables.find((t) => t.table === 'job_events');
  const repair =
    jobEvents?.windowDays == null
      ? { attempted: 0, finalized: 0, stillUnfinalized: [], withTruncatedHistory: [] }
      : await repairUnfinalized(jobEvents.windowDays, finalizeRepairMax());
  if (repair.attempted > 0) {
    logger.info(
      {
        attempted: repair.attempted,
        finalized: repair.finalized,
        stillUnfinalized: repair.stillUnfinalized.slice(0, NAMED_HELD_SESSIONS),
        stillUnfinalizedCount: repair.stillUnfinalized.length,
      },
      'retention: transcripts finalised so their events can go',
    );
  }
  if (repair.withTruncatedHistory.length > 0) {
    logger.warn(
      { sessions: repair.withTruncatedHistory },
      'retention: these sessions hold only part of their job\u2019s events, so their transcript cannot be finalised without truncating it \u2014 their events are kept and somebody has to decide',
    );
  }

  return {
    durationMs: Date.now() - t0,
    deleted: tables.reduce((sum, t) => sum + t.deleted, 0),
    tables,
    repair,
  };
}

let registered = false;

export async function registerRetentionSweeper(): Promise<void> {
  if (registered) return;
  // pg-boss v10 requires explicit createQueue before schedule/work can reference it.
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(RETENTION_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(RETENTION_QUEUE, async () => {
    try {
      const result = await runRetentionSweep();
      logger.info(
        { deleted: result.deleted, durationMs: result.durationMs },
        'retention: sweep complete',
      );
    } catch (err) {
      logger.error({ err }, 'retention: sweep failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(RETENTION_QUEUE, '0 3 * * *');
  registered = true;
}

export function resetRetentionSweeperForTest(): void {
  registered = false;
}
