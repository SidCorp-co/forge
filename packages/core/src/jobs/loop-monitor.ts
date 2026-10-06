import { JOB_MACHINE, OCCUPYING_JOB_STATUSES } from '@forge/contracts/job-machine';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { transition } from '../lifecycle/index.js';
import {
  CLASSIFIER_VERSION,
  emitPipelineWedge,
  resumeLapsedAnswers,
  type WedgeHop,
} from '../pipeline/index.js';
import { finalizeFailedJob } from './finalize-failure.js';
import { JOB_AXIS_SCAN_LIMIT, reportHopPage } from './hop-bounds.js';
import {
  isKillEpisodeLive,
  type KillableJobRef,
  killGraceMs,
  requestJobKill,
  resolveKillConfirmation,
} from './kill-gate.js';
import {
  countClaimHeldIssues,
  type LOOP_MONITOR_AXIS,
  type LoopMonitorOutOfAxis,
  reportLoopMonitorCoverage,
} from './loop-monitor-axis.js';
import { getLoopThresholds, RESULT_QUIET_MINUTES } from './loop-monitor-thresholds.js';
import { closeIdleResidents, reapExpiredParks, reapUnansweredParks } from './park-deadline.js';
import { quietJobCandidateQuery } from './progress-signal.js';
import { RESULT_EVENT_LATERAL, RESULT_GUARD } from './resident-session.js';
import { type SessionLostCause, sessionLostCause } from './session-lost-cause.js';
import { reapZombieSessions, type ZombieSessionReapResult } from './zombie-session-reaper.js';

type JobRow = typeof jobs.$inferSelect;

export interface LoopScope {
  projectId?: string;
}

interface JobAxisReapResult {
  reaped: number;
  killRequested: number;
  awaitingKill: number;
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
  /** parks closed because no process answered for them past the residency and its grace. */
  expiredParks: number;
  /** Resident chat sessions past their residency whose box was told to close them. */
  idleResidents: number;
  /** Processless parks closed at the deadline their asker set (ISS-964 c34). */
  unansweredParks: number;
  /** result-hop misses reaped (`stale`, no event for RESULT_QUIET_MINUTES). */
  resultMisses: JobAxisReapResult;
  /** answers whose session turned out to be gone, returned to the driver as a dispatch. */
  lapsedAnswers: number;
}

/** Raw-execute candidate row shared by every job-axis hop — the columns the
 *  kill gate needs (`toKillableRef`) plus the identifiers a wedge needs.
 *  A `type` (not `interface`) — `db.execute<T>`'s `T extends Record<string,
 *  unknown>` constraint only structurally matches object-literal types. */
type KillGateCandidateRow = {
  id: string;
  project_id: string;
  issue_id: string | null;
  device_id: string | null;
  runner_id: string | null;
  kill_requested_at: Date | string | null;
  kill_confirmed_at: Date | string | null;
  kill_outcome: JobRow['killOutcome'];
  failure_reason: string | null;
};

const KILL_GATE_CANDIDATE_COLUMNS = sql`j.id, j.project_id, j.issue_id, j.device_id, j.runner_id,
           j.kill_requested_at, j.kill_confirmed_at, j.kill_outcome`;

function toKillableRef(row: KillGateCandidateRow): KillableJobRef {
  return {
    id: row.id,
    projectId: row.project_id,
    deviceId: row.device_id,
    runnerId: row.runner_id,
    killRequestedAt: row.kill_requested_at ? new Date(row.kill_requested_at) : null,
    killConfirmedAt: row.kill_confirmed_at ? new Date(row.kill_confirmed_at) : null,
    killOutcome: row.kill_outcome,
  };
}

type KillGateReapDecision =
  | { phase: 'kill_requested' }
  | { phase: 'awaiting_kill' }
  | { phase: 'lost_race' }
  | { phase: 'reaped'; updated: JobRow; confirmed: boolean };

interface KillGateReapConfig {
  hop: WedgeHop;
  /** CAS predicate for the terminal flip — MUST include the same status
   *  guard the candidate SELECT used. */
  where: SQL | undefined;
  /** Written to `jobs.error` — also a SYNTHETIC_REAP_ERRORS marker, so keep it the short form. */
  error: string;
  /** Passed to `finalizeFailedJob`'s `error` option (logging / classifier
   *  fallback only). Defaults to `error` when the hop has no longer text. */
  finalizeError?: string;
  failureKind: SessionLostCause['failureKind'];
  failureReason: string;
  /** What tripped the hop — true on both the confirmed and unconfirmed
   *  branch, so the unconfirmed wedge extends it rather than replacing it. */
  wedgeReason: string;
  /** Action text for the CONFIRMED branch only (a retry is in flight). The
   *  unconfirmed branch owns `UNCONFIRMED_WEDGE_ACTION`. */
  confirmedWedgeAction: string;
  forceConfirmAfterGrace?: boolean;
}

async function resolveKillGateDecision(
  row: KillGateCandidateRow,
  cfg: KillGateReapConfig,
): Promise<KillGateReapDecision> {
  const ref = toKillableRef(row);

  const requestedAt = ref.killRequestedAt;
  if (!requestedAt || !isKillEpisodeLive(ref)) {
    await requestJobKill(ref, cfg.error);
    return { phase: 'kill_requested' };
  }

  if (Date.now() - requestedAt.getTime() < killGraceMs()) {
    await requestJobKill(ref, cfg.error);
    return { phase: 'awaiting_kill' };
  }

  const { confirmed, outcome } = cfg.forceConfirmAfterGrace
    ? { confirmed: true, outcome: ref.killOutcome ?? ('never_claimed' as const) }
    : await resolveKillConfirmation(ref);

  const set: Partial<Omit<JobRow, 'id' | 'status'>> = {
    error: cfg.error,
    finishedAt: new Date(),
    failureKind: cfg.failureKind,
    failureReason: cfg.failureReason,
    classifierVersion: CLASSIFIER_VERSION,
  };
  if (confirmed) set.killConfirmedAt = new Date();
  if (outcome) set.killOutcome = outcome;

  const [updated] = (
    await transition(db, JOB_MACHINE, {
      to: 'failed',
      set,
      where: cfg.where,
      reason: cfg.error,
      actor: { type: 'sweeper' },
      source: 'loop-monitor',
    })
  ).rows;
  if (!updated) return { phase: 'lost_race' };

  return { phase: 'reaped', updated, confirmed };
}

const UNCONFIRMED_WEDGE_ACTION =
  'NO retry was scheduled and the job is held. Before resuming it, check the assigned device and kill any agent process still running for this job — resuming while it lives puts two agents on the same worktree.';

async function finalizeKillGateReap(
  updated: JobRow,
  confirmed: boolean,
  cfg: Pick<
    KillGateReapConfig,
    'hop' | 'error' | 'finalizeError' | 'wedgeReason' | 'confirmedWedgeAction'
  >,
): Promise<void> {
  await emitPipelineWedge({
    projectId: updated.projectId,
    issueId: updated.issueId,
    hop: cfg.hop,
    entity: 'job',
    entityId: updated.id,
    reason: confirmed
      ? cfg.wedgeReason
      : `${cfg.wedgeReason} — and the runner never confirmed the kill, so its agent process may still be running on the device`,
    action: confirmed ? cfg.confirmedWedgeAction : UNCONFIRMED_WEDGE_ACTION,
  });
  const finalizeError = cfg.finalizeError ?? cfg.error;
  await finalizeFailedJob(
    updated,
    confirmed
      ? { error: finalizeError }
      : {
          error: finalizeError,
          precomputedRetry: { scheduled: false, reason: 'kill_unconfirmed' },
        },
  );
}

/**
 * Every job-axis hop's pass over its candidates: request the kill, wait out the
 * grace, then fail the job and route it through the shared finalize tail. A row
 * that throws is logged and skipped so one bad job never stops the sweep.
 */
export async function reapJobAxis(
  hop: string,
  candidates: readonly KillGateCandidateRow[],
  cfgFor: (row: KillGateCandidateRow) => KillGateReapConfig,
): Promise<JobAxisReapResult> {
  const result: JobAxisReapResult = { reaped: 0, killRequested: 0, awaitingKill: 0 };
  for (const row of candidates) {
    try {
      const cfg = cfgFor(row);
      const decision = await resolveKillGateDecision(row, cfg);
      if (decision.phase === 'kill_requested') result.killRequested++;
      else if (decision.phase === 'awaiting_kill') result.awaitingKill++;
      else if (decision.phase === 'reaped') {
        result.reaped++;
        await finalizeKillGateReap(decision.updated, decision.confirmed, cfg);
      }
    } catch (err) {
      logger.error({ err, jobId: row.id }, `loop-monitor: ${hop} reap failed (row skipped)`);
    }
  }
  if (result.reaped > 0) {
    logger.info({ reaped: result.reaped }, `loop-monitor: ${hop} jobs reaped to failed`);
  }
  return reportHopPage(hop, candidates.length, result);
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
    SELECT ${KILL_GATE_CANDIDATE_COLUMNS}
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

  return reapJobAxis('ack', candidates, (row) => ({
    hop: 'ack',
    where: and(eq(jobs.id, row.id), eq(jobs.status, 'dispatched')),
    error: 'dispatch_unclaimed',
    failureKind: 'infra',
    failureReason:
      'dispatch never claimed by a runner (no ack / no started event within grace window)',
    wedgeReason:
      'runner never acked the dispatch (no ack, zero job events) within the grace window',
    confirmedWedgeAction:
      'Check the assigned device is online and its forge-runner daemon is running. The job was auto-failed and routed to device-rotated retry; if it recurs, rotate or unbind the device.',
    forceConfirmAfterGrace: true,
  }));
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
async function reapSessionLostJobs(scope: LoopScope): Promise<JobAxisReapResult> {
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  const candidates = await db.execute<KillGateCandidateRow>(sql`
    SELECT ${KILL_GATE_CANDIDATE_COLUMNS}, s.failure_reason
    FROM jobs j
    JOIN agent_sessions s ON s.id = j.agent_session_id
    ${RESULT_EVENT_LATERAL}
    WHERE j.status = 'dispatched'
      AND s.status IN ('failed', 'cancelled_stale')
      AND ${RESULT_GUARD}
      ${projectClause}
    ORDER BY j.dispatched_at ASC NULLS FIRST LIMIT ${sql.raw(String(JOB_AXIS_SCAN_LIMIT))}
  `);

  return reapJobAxis('session-lost', candidates, (row) => ({
    hop: 'heartbeat',
    where: and(eq(jobs.id, row.id), inArray(jobs.status, OCCUPYING_JOB_STATUSES)),
    ...sessionLostCause(row.failure_reason),
  }));
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

async function reapResultMisses(scope: LoopScope): Promise<JobAxisReapResult> {
  const query = resultMissCandidateQuery(scope, JOB_AXIS_SCAN_LIMIT);
  const candidates = await db.execute<KillGateCandidateRow>(query);

  const STALE_REASON = `runner stale (no progress / no started event for >${RESULT_QUIET_MINUTES}min)`;
  return reapJobAxis('result', candidates, (row) => ({
    hop: 'result',
    where: and(eq(jobs.id, row.id), inArray(jobs.status, OCCUPYING_JOB_STATUSES)),
    error: 'stale',
    finalizeError: STALE_REASON,
    failureKind: 'timeout',
    failureReason: STALE_REASON,
    wedgeReason: STALE_REASON,
    confirmedWedgeAction:
      'The job was failed and routed to a device-rotated retry. Check the original device for a hung Claude CLI / runaway step.',
  }));
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
    idleResidents: await closeIdleResidents(now, scope),
    unansweredParks: await reapUnansweredParks(now, scope),
  };
  const sessionLostJobs = await reapSessionLostJobs(scope);
  const resultMisses = await reapResultMisses(scope);
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
