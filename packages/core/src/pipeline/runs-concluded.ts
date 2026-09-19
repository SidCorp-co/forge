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

const QUIET_WINDOW_MS = RESULT_QUIET_MINUTES * 60_000;

function selectConcluded(now: Date, scope: LoopScope) {
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
      if ((await closeRun(row.id, outcome)) === 'settled') reaped++;
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
