import { OCCUPYING_JOB_STATUSES } from '@forge/contracts/job-machine';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { resumeLapsedAnswers } from '../pipeline/index.js';
import { JOB_AXIS_SCAN_LIMIT } from './hop-bounds.js';
import {
  type JobAxisReapResult,
  KILL_GATE_CANDIDATE_COLUMNS,
  type KillGateCandidateRow,
  reapJobAxis,
} from './kill-gate-reap.js';
import {
  countClaimHeldIssues,
  type LOOP_MONITOR_AXIS,
  type LoopMonitorOutOfAxis,
  reportLoopMonitorCoverage,
} from './loop-monitor-axis.js';
import { getLoopThresholds, RESULT_QUIET_MINUTES } from './loop-monitor-thresholds.js';
import { reapExpiredParks, reapUnansweredParks } from './park-deadline.js';
import { quietJobCandidateQuery } from './progress-signal.js';
import { RESULT_EVENT_LATERAL, RESULT_GUARD } from './resident-session.js';
import { sessionLostCause } from './session-lost-cause.js';
import { reapZombieSessions, type ZombieSessionReapResult } from './session-reap.js';

export interface LoopScope {
  projectId?: string;
}

export interface LoopMonitorResult {
  /** ISS-1273 — the one axis every hop in this result sweeps, and what it therefore misses. */
  axis: typeof LOOP_MONITOR_AXIS;
  outOfAxis: LoopMonitorOutOfAxis;
  /** dispatch→ack misses reaped (`dispatch_unclaimed`). */
  ackMisses: JobAxisReapResult;
  /** Session-level claim/heartbeat misses reaped. */
  sessions: ZombieSessionReapResult;
  /** Jobs failed because their linked session is terminal (`session_lost`). */
  sessionLostJobs: JobAxisReapResult;
  /** parks closed because the runner never honoured its own residency ceiling. */
  expiredParks: number;
  /** Processless parks closed at the deadline their asker set (ISS-964 c34). */
  unansweredParks: number;
  /** result-hop misses reaped (`stale`, no event for RESULT_QUIET_MINUTES). */
  resultMisses: JobAxisReapResult;
  /** answers whose session turned out to be gone, returned to the driver as a dispatch. */
  lapsedAnswers: number;
}

/**
 * Hop 1 — dispatch→ack. A `dispatched` job that was never acked and emitted
 * zero events past the grace window: no runner claimed it. CAS on
 * `status='dispatched'` so a runner that acks in the same instant wins.
 *
 * ISS-785 — still two-phase (a kill is requested before the job fails), but
 * the candidate predicate itself proves no process exists, so confirmation
 * is forced true once the grace elapses (see
 * `KillGateReapConfig.forceConfirmAfterGrace`) — this hop now fails at
 * `ackMs + killGraceMs()` instead of `ackMs` alone.
 */
export async function reapAckMisses(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<JobAxisReapResult> {
  const { ackMs } = getLoopThresholds();
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  const cutoffIso = new Date(now.getTime() - ackMs).toISOString();
  const candidates = await db.execute<KillGateCandidateRow>(sql`
    SELECT j.id, j.project_id, j.issue_id, j.device_id, j.runner_id,
           j.kill_requested_at, j.kill_confirmed_at, j.kill_outcome
    FROM jobs j
    WHERE j.status = 'dispatched'
      AND j.acked_at IS NULL
      AND j.dispatched_at IS NOT NULL
      AND j.dispatched_at < ${cutoffIso}
      AND NOT EXISTS (
        SELECT 1 FROM job_events e WHERE e.job_id = j.id
      )
      ${projectClause}
    ORDER BY j.dispatched_at ASC LIMIT ${sql.raw(String(JOB_AXIS_SCAN_LIMIT))}
  `);

  return reapJobAxis(
    'ack',
    candidates,
    (row) => ({
      hop: 'ack',
      where: and(eq(jobs.id, row.id), eq(jobs.status, 'dispatched')),
      fromStatus: 'dispatched',
      error: 'dispatch_unclaimed',
      failureKind: 'infra',
      failureReason:
        'dispatch never claimed by a runner (no ack / no started event within grace window)',
      wedgeReason:
        'runner never acked the dispatch (no ack, zero job events) within the grace window',
      confirmedWedgeAction:
        'Check the assigned device is online and its forge-runner daemon is running. The job was auto-failed and routed to device-rotated retry; if it recurs, rotate or unbind the device.',
      forceConfirmAfterGrace: true,
    }),
    {
      skipped: 'loop-monitor: ack-miss reap failed (row skipped)',
      reaped: 'loop-monitor: ack-hop misses reaped to failed',
    },
  );
}

/**
 * Hop 3c (job axis) — session-lost propagation. When a linked session is
 * terminal but its job is still active, kill-gate it and route the confirmed
 * reap through the shared finalize tail. Moved from pipeline/sweeper.ts
 * `reconcileOrphanedJobs` (ISS-280 semantics preserved; its result-event
 * false-positive guard now reads print-only, see `resident-session.ts`).
 *
 * ISS-37 lived here: the session heartbeat hop had already failed the
 * linked session while the job's own process kept running, and this hop —
 * pre-kill-gate — failed the job on the very same read, letting the retry it
 * scheduled dispatch a second agent onto the still-live worktree.
 */
async function reapSessionLostJobs(
  _now: Date = new Date(),
  scope: LoopScope = {},
): Promise<JobAxisReapResult> {
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  const candidates = await db.execute<KillGateCandidateRow>(sql`
    SELECT j.id, j.project_id, j.issue_id, j.device_id, j.runner_id,
           j.kill_requested_at, j.kill_confirmed_at, j.kill_outcome, s.failure_reason
    FROM jobs j
    JOIN agent_sessions s ON s.id = j.agent_session_id
    ${RESULT_EVENT_LATERAL}
    WHERE j.status IN ('dispatched', 'running')
      AND s.status IN ('failed', 'cancelled_stale')
      AND ${RESULT_GUARD}
      ${projectClause}
    ORDER BY j.dispatched_at ASC NULLS FIRST LIMIT ${sql.raw(String(JOB_AXIS_SCAN_LIMIT))}
  `);

  return reapJobAxis(
    'session-lost',
    candidates,
    (row) => ({
      hop: 'heartbeat',
      where: and(eq(jobs.id, row.id), inArray(jobs.status, OCCUPYING_JOB_STATUSES)),
      fromStatus: 'active',
      ...sessionLostCause(row.failure_reason),
    }),
    {
      skipped: 'loop-monitor: session-lost reap failed (row skipped)',
      reaped: 'loop-monitor: session-lost jobs reconciled to failed',
    },
  );
}

/**
 * Hop 4 — result. A claimed job whose latest event (or dispatch, if events
 * are gone quiet entirely) is older than RESULT_QUIET_MINUTES: the worker is
 * wedged. Moved from jobs/stale-detector.ts `runStaleSweep` (ISS-258
 * semantics preserved; its finalize-drop guard and the park exemption are
 * both in `resident-session.ts`), now ticking every minute.
 *
 * ISS-1013 — the query is exported rather than inlined so a plan can be read
 * off the subject itself. A test that EXPLAINs a hand-written likeness of this
 * query measures the likeness, and stays green while the shape the sweeper
 * actually runs drifts away from it.
 */
function resultMissCandidateQuery(scope: LoopScope = {}, limit?: number): SQL {
  return quietJobCandidateQuery({
    columns: KILL_GATE_CANDIDATE_COLUMNS,
    quietMinutes: RESULT_QUIET_MINUTES,
    scope,
    limit,
  });
}

async function reapResultMisses(
  _now: Date = new Date(),
  scope: LoopScope = {},
): Promise<JobAxisReapResult> {
  const query = resultMissCandidateQuery(scope, JOB_AXIS_SCAN_LIMIT);
  const candidates = await db.execute<KillGateCandidateRow>(query);

  const STALE_REASON = `runner stale (no progress / no started event for >${RESULT_QUIET_MINUTES}min)`;
  return reapJobAxis(
    'result',
    candidates,
    (row) => ({
      hop: 'result',
      where: and(eq(jobs.id, row.id), inArray(jobs.status, OCCUPYING_JOB_STATUSES)),
      fromStatus: 'active',
      error: 'stale',
      finalizeError: STALE_REASON,
      failureKind: 'timeout',
      failureReason: STALE_REASON,
      wedgeReason: STALE_REASON,
      confirmedWedgeAction:
        'The job was failed and routed to a device-rotated retry. Check the original device for a hung Claude CLI / runaway step.',
    }),
    {
      skipped: 'loop-monitor: result-miss reap failed (row skipped)',
      reaped: 'loop-monitor: result-hop misses reaped to failed',
    },
  );
}

/**
 * One loop tick: every hop once, in dependency order — ack first (frees
 * never-claimed dispatches fast), then the session hops, then session-lost
 * propagation (so a session failed THIS tick immediately frees its job/runner
 * slot — ISS-280 same-tick propagation preserved), then the result hop.
 */
export async function runLoopMonitor(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<LoopMonitorResult> {
  const ackMisses = await reapAckMisses(now, scope);
  const sessions = await reapZombieSessions(now, scope);
  const parkClocks = {
    expiredParks: await reapExpiredParks(now, scope),
    unansweredParks: await reapUnansweredParks(now, scope),
  };
  const sessionLostJobs = await reapSessionLostJobs(now, scope);
  const resultMisses = await reapResultMisses(now, scope);
  const lapsedAnswers = await resumeLapsedAnswers(now, scope);
  const { axis, ...outOfAxis } = reportLoopMonitorCoverage(await countClaimHeldIssues(now, scope));
  return {
    axis,
    outOfAxis,
    ackMisses,
    sessions,
    ...parkClocks,
    sessionLostJobs,
    resultMisses,
    lapsedAnswers,
  };
}
