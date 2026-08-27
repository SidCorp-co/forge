// Filling the phase journal from staged history (agent-driven pipeline, 2b).
//
// In staged mode one job IS one phase, so the journal needs no new write path
// on the job lifecycle — every fact it wants already sits in `jobs` and
// `agent_sessions`. Deriving instead of hooking reaches BACKWARDS over months
// of finished runs, so the phase-5 comparison starts with real history instead
// of accruing from today, and it touches no hot path, so it cannot wedge the
// running pipeline.
//
// It runs on its own hourly schedule rather than inside the every-minute
// pipeline sweep: nothing depends on it being fresh, and a slow pass over
// historical runs has no business sharing a tick with the reapers that keep the
// orphan invariant.
//
// Design: docs/proposals/agent-driven-pipeline.md

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';

export const PHASE_JOURNAL_BACKFILL_QUEUE = 'phase-journal-backfill';

const DEFAULT_BATCH_RUNS = 200;

export interface BackfillResult {
  runs: number;
  rows: number;
}

/**
 * Runs whose every job has finished and which have no journal rows yet, oldest
 * first.
 */
// cm:guard a run with ANY unfinished job is deliberately skipped, not partially written: attempt numbers come from the run's whole job list, so numbering half of it now and the rest later would hand the same number to two different jobs, and the unique index would drop the second one silently
async function claimableRunIds(batchRuns: number): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT pr.id
    FROM pipeline_runs pr
    WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.pipeline_run_id = pr.id)
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.pipeline_run_id = pr.id
          AND j.status NOT IN ('done', 'failed', 'cancelled')
      )
      AND NOT EXISTS (SELECT 1 FROM phase_journal pj WHERE pj.run_id = pr.id)
    ORDER BY pr.created_at
    LIMIT ${batchRuns}
  `);
  return [...rows].map((r) => r.id);
}

/**
 * Derive and insert one batch. Idempotent: a row that already exists for a
 * `(run, phase, attempt)` is left alone, so a re-run after a partial failure
 * repeats work rather than corrupting it.
 */
// cm:guard the derivation is SQL, not TypeScript, because the timestamps must land BYTE-IDENTICAL: a Date round-trip through node truncates Postgres microseconds to milliseconds, and phase_step_durations then disagrees with pipeline_run_step_durations on every row it copies
// cm:edge contract -> packages/core/drizzle/migrations/0184_phase_step_durations_view.sql — outcome/started_at here are what that view reads as status/span; change one without the other and the parity test fails
export async function backfillPhaseJournal(
  batchRuns: number = DEFAULT_BATCH_RUNS,
): Promise<BackfillResult> {
  const runIds = await claimableRunIds(batchRuns);
  if (runIds.length === 0) return { runs: 0, rows: 0 };

  // cm:guard started_at mirrors pipeline_run_step_durations' own COALESCE(agent_sessions.started_at, jobs.dispatched_at), and the WHERE drops a job that has neither rather than inventing a start — a job filtered here also spends no attempt number, because WHERE is applied before the window function
  // cm:why `cancelled` is `abandoned`, not `failed` — a cascade-cancelled job is not evidence the step went wrong, and counting it as a failure makes every closed run look broken
  const inserted = await db.execute(sql`
    INSERT INTO phase_journal (
      project_id, run_id, issue_id, job_id, agent_session_id,
      phase, attempt, source, outcome, started_at, ended_at
    )
    SELECT
      j.project_id,
      j.pipeline_run_id,
      r.issue_id,
      j.id,
      j.agent_session_id,
      j.type,
      ROW_NUMBER() OVER (
        PARTITION BY j.pipeline_run_id, j.type ORDER BY j.queued_at, j.id
      ),
      'system',
      CASE j.status WHEN 'done' THEN 'ok' WHEN 'failed' THEN 'failed' ELSE 'abandoned' END,
      COALESCE(s.started_at, j.dispatched_at),
      j.finished_at
    FROM jobs j
    INNER JOIN pipeline_runs r ON r.id = j.pipeline_run_id
    LEFT JOIN agent_sessions s ON s.id = j.agent_session_id
    WHERE j.pipeline_run_id = ANY(${sql.raw(`ARRAY[${runIds.map((id) => `'${id}'::uuid`).join(',')}]`)})
      AND COALESCE(s.started_at, j.dispatched_at) IS NOT NULL
    ON CONFLICT DO NOTHING
  `);

  return { runs: runIds.length, rows: (inserted as unknown as { count?: number }).count ?? 0 };
}

let registered = false;

export async function registerPhaseJournalBackfill(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).createQueue(PHASE_JOURNAL_BACKFILL_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).work(PHASE_JOURNAL_BACKFILL_QUEUE, async () => {
    const result = await backfillPhaseJournal();
    if (result.rows > 0) logger.info(result, 'phase-journal-backfill: wrote rows');
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).schedule(PHASE_JOURNAL_BACKFILL_QUEUE, '17 * * * *');
  registered = true;
}

export function resetPhaseJournalBackfillForTest(): void {
  registered = false;
}
