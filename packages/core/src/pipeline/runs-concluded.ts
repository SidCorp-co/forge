/**
 * ISS-923 — the orphan invariant, read in the other direction.
 *
 * `runs-cascade.ts` defends one way: no child job stays non-terminal under a
 * terminal run. The INVERSE — no run stays non-terminal once every child job is
 * terminal — was defended by nothing, and neither run-axis reaper in
 * `sweeper.ts` reaches these: `reapOrphanedOneShotRuns` requires
 * `NOT EXISTS (jobs)`, `reapOrphanedIssueRuns` requires a closed/dropped issue.
 *
 * ISS-654 widened this module to the two phantom shapes that were still reading
 * as live work: a `paused` run whose backing is provably gone, and a
 * `kind='issue'` run that never grew a job at all.
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

export interface JoblessRunReapResult {
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

// cm:guard `paused` is admitted (ISS-654) ONLY under the extra no-live-session clause below, never on the all-jobs-terminal test alone — `run-pause.ts` documents `paused` as an operator hold, and a hold that could still be resumed into work is a human's decision this pass may not override. A paused run with every job terminal, nothing beating on it and an hour of silence has nothing left to resume into, which is the one shape that is a phantom rather than a hold.
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
    WHERE r.status IN ('running', 'paused')
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
      AND (
        r.status = 'running'
        OR NOT EXISTS (
          SELECT 1 FROM agent_sessions s
          WHERE s.pipeline_run_id = r.id
            AND s.status IN ('queued', 'running', 'idle')
        )
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
 * Close every `running` or `paused` run whose child jobs have ALL reached a
 * terminal status and stayed that way for `RESULT_QUIET_MINUTES`. A `paused`
 * run additionally has to hold no live `agent_session`.
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

type JoblessCandidate = {
  id: string;
  project_id: string;
  issue_id: string | null;
  any_completed: boolean;
  any_failed: boolean;
};

// cm:guard `kind = 'issue'` only — `reapOrphanedOneShotRuns` already owns the job-less `system`/`interactive` rows on its own device-aware grace, and two passes reaping one row would race to close it twice.
// cm:guard the window is the SAME RESULT_QUIET_MINUTES, never the shorter heartbeat floor the one-shot reaper uses: an issue run is opened BEFORE its first job is enqueued, so a cutoff measured in minutes would close a run that is about to be dispatched into and leave the dispatch pointing at a terminal run.
// cm:guard a live `agent_session` excludes the row even with no jobs — an interactive drive attached to the issue run reports through the session, not a job, and closing under it fires the terminal-run trigger that orphans the session.
function selectJobless(now: Date, scope: LoopScope) {
  const quietCutoffIso = new Date(now.getTime() - QUIET_WINDOW_MS).toISOString();
  const projectClause = scope.projectId ? sql`AND r.project_id = ${scope.projectId}` : sql``;
  return db.execute<JoblessCandidate>(sql`
    SELECT r.id, r.project_id, r.issue_id,
           EXISTS (
             SELECT 1 FROM agent_sessions s
             WHERE s.pipeline_run_id = r.id
               AND s.status IN ('completed', 'completed_via_recovery')
           ) AS any_completed,
           EXISTS (
             SELECT 1 FROM agent_sessions s
             WHERE s.pipeline_run_id = r.id
               AND s.status IN ('failed', 'cancelled_stale')
           ) AS any_failed
    FROM pipeline_runs r
    WHERE r.kind = 'issue'
      AND r.status IN ('running', 'paused')
      AND r.started_at < ${quietCutoffIso}
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.pipeline_run_id = r.id)
      AND NOT EXISTS (
        SELECT 1 FROM agent_sessions s
        WHERE s.pipeline_run_id = r.id
          AND s.status IN ('queued', 'running', 'idle')
      )
      ${projectClause}
    ORDER BY r.started_at ASC
    LIMIT 200
  `);
}

/**
 * Close every `kind='issue'` run that never grew a job and has gone quiet past
 * `RESULT_QUIET_MINUTES` with no live session under it.
 */
// cm:guard `cancelled`, not `failed`, when nothing ever ran under the run — a run with no job and no session produced no failure to report, and stamping one puts a fiction in the outcome every success-rate metric reads.
export async function reapJoblessRuns(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<JoblessRunReapResult> {
  const candidates = await selectJobless(now, scope);

  let reaped = 0;
  for (const row of candidates) {
    const outcome: 'completed' | 'failed' | 'cancelled' = row.any_completed
      ? row.any_failed
        ? 'failed'
        : 'completed'
      : row.any_failed
        ? 'failed'
        : 'cancelled';
    try {
      logger.info(
        { runId: row.id, projectId: row.project_id, issueId: row.issue_id, outcome },
        'pipeline-sweeper: closing job-less issue run (no job ever enqueued)',
      );
      await closeRun(row.id, outcome);
      reaped++;
    } catch (err) {
      logger.error(
        { err, runId: row.id, projectId: row.project_id },
        'pipeline-sweeper: job-less issue run reap failed (row skipped)',
      );
    }
  }

  if (reaped > 0) {
    logger.info({ reaped, at: now.toISOString() }, 'pipeline-sweeper: job-less issue runs closed');
  }

  return { reaped };
}
