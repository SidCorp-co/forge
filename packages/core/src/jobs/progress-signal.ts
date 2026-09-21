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
  killGateCutoffIso?: string;
  /**
   * How many candidates one call may take, oldest dispatch first.
   *
   * ISS-1021 — a REAPER's term, never an alarm's. A reaper writes each row it takes terminal, so
   * its candidate set shrinks and a bound is a deferral; the stale alarm writes nothing and must
   * keep seeing the whole backlog, because saying the loop fell behind is the one thing it is for.
   * Leave it unset and the query is unbounded exactly as it was.
   */
  limit?: number | undefined;
}

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
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
    throw new Error(
      `quietJobCandidateQuery: limit must be a positive integer, got ${String(opts.limit)}`,
    );
  }
  const limitClause =
    opts.limit === undefined
      ? sql``
      : sql`ORDER BY j.dispatched_at ASC NULLS FIRST LIMIT ${sql.raw(String(opts.limit))}`;

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
    ${limitClause}
  `;
}
