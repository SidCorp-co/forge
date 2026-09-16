// What counts as a job still making progress, and the one query shape that
// reads it (agent-driven pipeline, phase 3).
//
// The result hop reaps a claimed job that has gone quiet. "Quiet" used to mean
// only "no job_event", which is right for a staged step: it runs minutes and
// emits as it goes. An autonomous session runs ONE job for hours, and the
// signal that it is alive is the phase it declares — so a declared phase has
// to count as progress too, or the watchdog kills a driver that is working.
//
// This adds a term to the hop's existing quiet computation. It is deliberately
// not a second reaper: the hop, the kill gate and RESULT_QUIET_MINUTES are
// untouched.
//
// ISS-1013 — the two maxima are read per driving job, not aggregated over the
// tables first. The CTE form this replaced computed `MAX(ts) ... GROUP BY
// job_id` over the whole of `job_events` and `MAX(...) ... GROUP BY run_id`
// over the whole of `phase_journal`, then LEFT JOINed the result to the few
// dozen `dispatched|running` jobs — so answering a question about live work
// cost every event and every phase row ever written.

import { type SQL, sql } from 'drizzle-orm';
import {
  NOT_PARKED,
  RESIDENT_SESSION_JOIN,
  RESULT_EVENT_LATERAL,
  RESULT_GUARD,
} from './resident-session.js';

export const LAST_EVENT_LATERAL = sql`LEFT JOIN LATERAL (SELECT max(e.ts) AS max_ts FROM job_events e WHERE e.job_id = j.id) le ON true`;

export const LAST_PHASE_LATERAL = sql`LEFT JOIN LATERAL (SELECT max(GREATEST(p.started_at, COALESCE(p.ended_at, p.started_at))) AS max_ts FROM phase_journal p WHERE p.run_id = j.pipeline_run_id) lp ON true`;

export const LAST_PROGRESS_AT = sql`GREATEST(COALESCE(le.max_ts, j.dispatched_at), COALESCE(lp.max_ts, j.dispatched_at), j.dispatched_at)`;

export interface QuietJobCandidateOptions {
  /** Columns to select off the driving `jobs` row, which is aliased `j`. */
  columns: SQL;
  /** How long a job must have shown no progress by `LAST_PROGRESS_AT`. */
  quietMinutes: number;
  /** Restrict to one project, as every periodic pass here can be. */
  scope?: { projectId?: string };
  /**
   * When set, drop a job whose kill was requested more recently than this —
   * an ALARM's term, never a reaper's. The loop deliberately leaves a gated
   * row active until `killGraceMs()` elapses, so a pass that reports such a
   * row as a miss reports the gate working.
   */
  killGateCutoffIso?: string;
}

/**
 * The one candidate query the result hop and the stale alarm both run.
 *
 * It exists as a builder rather than as two texts so the two predicates are
 * ONE object: the alarm's whole job is to say that the loop did not act on a
 * row it should have, which it can only mean while it selects the same rows
 * the loop does. They differ in the threshold, in the columns and in the
 * kill-gate term, and in nothing else.
 */
export function quietJobCandidateQuery(opts: QuietJobCandidateOptions): SQL {
  if (!Number.isInteger(opts.quietMinutes) || opts.quietMinutes <= 0) {
    throw new Error(
      `quietJobCandidateQuery: quietMinutes must be a positive integer, got ${String(opts.quietMinutes)}`,
    );
  }
  const projectClause = opts.scope?.projectId
    ? sql`AND j.project_id = ${opts.scope.projectId}`
    : sql``;
  const killGateClause = opts.killGateCutoffIso
    ? sql`AND (j.kill_requested_at IS NULL OR j.kill_requested_at <= ${opts.killGateCutoffIso})`
    : sql``;

  return sql`
    SELECT ${opts.columns}
    FROM jobs j
    ${LAST_EVENT_LATERAL}
    ${LAST_PHASE_LATERAL}
    ${RESIDENT_SESSION_JOIN}
    ${RESULT_EVENT_LATERAL}
    WHERE j.status IN ('dispatched', 'running')
      AND ${RESULT_GUARD}
      AND ${NOT_PARKED}
      AND ${LAST_PROGRESS_AT} < now() - interval '${sql.raw(String(opts.quietMinutes))} minutes'
      ${projectClause}
      ${killGateClause}
  `;
}
