/**
 * ISS-923 — the orphan invariant, read in the other direction.
 *
 * `runs-cascade.ts` defends one way: no child job stays non-terminal under a
 * terminal run. The INVERSE — no run stays non-terminal once every child job is
 * terminal — was defended by nothing: the cascade fires when a run closes, and
 * nothing fired when the LAST job of an open run finished. Measured on the
 * fleet 2026-09-06: 98 of 114 `running` runs across 18 projects.
 *
 * Neither existing run-axis reaper in `sweeper.ts` reaches these:
 * `reapOrphanedOneShotRuns` requires `NOT EXISTS (jobs)`, and
 * `reapOrphanedIssueRuns` requires the backing issue to be closed/dropped.
 *
 * Why closing is safe: `runs.ts openIssueRun` opens a FRESH run when none is
 * open, so a later dispatch loses nothing; and `jobs/retry.ts` INSERTs a retry
 * clone at `queued` BEFORE its delayed enqueue, so a backing-off retry always
 * leaves a non-terminal job and excludes the run here.
 *
 * The whole flow, both directions: docs/flows/lifecycle-pipeline.html
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { LoopScope } from '../jobs/loop-monitor.js';
import { RESULT_QUIET_MINUTES } from '../jobs/loop-monitor.js';
import { logger } from '../logger.js';
import { closeRun } from './runs.js';

export interface ConcludedRunReapResult {
  reaped: number;
}

type Candidate = {
  id: string;
  project_id: string;
  issue_id: string | null;
  kind: string;
  last_job_id: string;
  last_job_status: 'done' | 'failed' | 'cancelled';
};

// cm:edge contract -> packages/core/src/jobs/loop-monitor.ts — the quiet window is RESULT_QUIET_MINUTES, deliberately the SAME number and not a knob of its own: 60 minutes is already this repo's stated ceiling for how long a legitimate pipeline may go quiet, and two thresholds for one question drift apart.
const QUIET_WINDOW_MS = RESULT_QUIET_MINUTES * 60_000;

// cm:guard `status = 'running'` only, never `paused` — `run-pause.ts` documents `paused` as an operator-only pause today, and a sweeper that closes one silently overrides a human's deliberate hold.
// cm:guard the `EXISTS (jobs)` clause is load-bearing in BOTH directions: it keeps this pass off `reapOrphanedOneShotRuns`' job-less rows, and it is what makes an open run at issue-status `released` judgeable here without contradicting ISS-669. ISS-669 protects a `released` issue whose release step is STILL RUNNING inside the open run — that run has an active job and is excluded by the clause below, whereas one whose release job went terminal days ago is exactly the leak.
function selectConcluded(now: Date, scope: LoopScope) {
  // cm:guard the cutoff is bound from the caller's `now`, never SQL's `now()` — the same shape `reapOrphanedOneShotRuns` uses, and the only thing that makes the `now` parameter mean anything. Read the server clock here instead and a test that pins the clock silently proves nothing about the window it thinks it set.
  // cm:why serialised to ISO because postgres-js rejects a raw Date param.
  const quietCutoffIso = new Date(now.getTime() - QUIET_WINDOW_MS).toISOString();
  const projectClause = scope.projectId ? sql`AND r.project_id = ${scope.projectId}` : sql``;
  return db.execute<Candidate>(sql`
    SELECT r.id, r.project_id, r.issue_id, r.kind,
           last_job.id AS last_job_id,
           last_job.status AS last_job_status
    FROM pipeline_runs r
    JOIN LATERAL (
      SELECT j.id, j.status
      FROM jobs j
      WHERE j.pipeline_run_id = r.id
      ORDER BY j.finished_at DESC NULLS LAST, j.created_at DESC
      LIMIT 1
    ) last_job ON TRUE
    WHERE r.status = 'running'
      AND NOT EXISTS (
        SELECT 1 FROM jobs j2
        WHERE j2.pipeline_run_id = r.id
          AND j2.status IN ('queued', 'dispatched', 'running', 'held')
      )
      AND NOT EXISTS (
        SELECT 1 FROM jobs j3
        WHERE j3.pipeline_run_id = r.id
          AND COALESCE(j3.finished_at, j3.created_at) >= ${quietCutoffIso}
      )
      ${projectClause}
    ORDER BY r.started_at ASC
    LIMIT 200
  `);
}

// cm:guard the run's outcome is its LAST job's, never an any-failed rollup — a run whose failed job was RETRIED to success concluded successfully, and reporting it `failed` would make the run status lie in the other direction. Requirement 2 of ISS-923 is stated about the last job for exactly this reason.
function outcomeFor(
  lastJobStatus: Candidate['last_job_status'],
): 'completed' | 'failed' | 'cancelled' {
  if (lastJobStatus === 'done') return 'completed';
  if (lastJobStatus === 'failed') return 'failed';
  return 'cancelled';
}

/**
 * Close every `running` run whose child jobs have ALL reached a terminal status
 * and stayed that way for `RESULT_QUIET_MINUTES`.
 */
// cm:edge lockstep -> packages/core/src/pipeline/runs-cascade.ts — the inverse of that module's orphan invariant; the forward defences and this one are one statement read in two directions and are documented together.
// cm:guard best-effort per row — one failure is logged and skipped, never aborting the pass, the convention both sibling reapers in `sweeper.ts` follow.
// cm:why the per-row log line is required, not decoration: ISS-923 asks for the reconciliation to be auditable run by run rather than a bulk UPDATE, and it is also how the standing backlog drains — this pass closes the existing leak on its own first ticks after deploy, so no one-shot migration exists to go stale.
export async function reapConcludedRuns(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<ConcludedRunReapResult> {
  const candidates = await selectConcluded(now, scope);

  let reaped = 0;
  for (const row of candidates) {
    const outcome = outcomeFor(row.last_job_status);
    try {
      logger.info(
        {
          runId: row.id,
          projectId: row.project_id,
          issueId: row.issue_id,
          kind: row.kind,
          lastJobId: row.last_job_id,
          lastJobStatus: row.last_job_status,
          outcome,
        },
        'pipeline-sweeper: closing concluded run (every child job terminal)',
      );
      await closeRun(row.id, outcome);
      reaped++;
    } catch (err) {
      logger.error(
        { err, runId: row.id, projectId: row.project_id },
        'pipeline-sweeper: concluded run reap failed (row skipped)',
      );
    }
  }

  if (reaped > 0) {
    logger.info({ reaped, at: now.toISOString() }, 'pipeline-sweeper: concluded runs closed');
  }

  return { reaped };
}
