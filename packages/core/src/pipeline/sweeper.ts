/**
 * Pipeline sweeper tick — loop-monitor driver + demoted alarm passes.
 *
 * ISS-449 (ISS-442 C3 / invariant I3) — the closed job loop
 * (`jobs/loop-monitor.ts`) is now the PRIMARY mechanism: it owns the
 * dispatch→ack→heartbeat→result hop timeouts and performs every terminal
 * write (via `applyKernelTransition`) as the FIRST pass of this tick. The
 * three sweep passes this file used to own — `sweepZombieSessions`,
 * `reconcileOrphanedJobs`, `reconcileNeverClaimedDispatches` — are DEMOTED to
 * assertion/alarm (renamed `alarm*`): they keep their detection SELECTs but
 * perform NO terminal writes. A row they still match is a loop MISS, logged
 * as `loop-miss` and surfaced as a `pipeline_wedge` (coverage proof during
 * the cutover; deleted at the ISS-442 parent integration once the loop is
 * proven).
 *
 * Still active here (not part of the demoted four): the one-shot run reaper
 * (ISS-445), the dispatcher backstop, queue snapshots (ISS-381), and the
 * Tier 1 ops alert sweep (ISS-652, shares query logic with GET
 * /api/admin/alerts via `admin/alert-queries.ts`).
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { type AlertSweepResult, runAlertSweep } from '../admin/alert-sweeper.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { broadcastSessionEvent } from '../jobs/agent-session-link.js';
import { killGraceMs } from '../jobs/kill-gate.js';
import {
  getLoopThresholds,
  type LoopMonitorResult,
  type LoopScope,
  runLoopMonitor,
} from '../jobs/loop-monitor.js';
import { recordPipelineSweeperTick } from '../jobs/pgboss-health.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { boss } from '../queue/boss.js';
import {
  alarmAgedHolds,
  alarmPausedRunsWithQueuedWork,
  alarmRejectionStreaks,
  alarmStalledQueuedJobs,
  type Inv7AlarmResult,
} from './inv7-alarms.js';
import { detectRetryRescueThresholds, type RetryRescueAlertResult } from './retry-rescue-alert.js';
import { type OrphanedPauseResult, resumeOrphanedPauses } from './run-pause.js';
import { closeOpenRunForIssue, closeRunIfOneShot } from './runs.js';
import {
  type ConcludedRunReapResult,
  type JoblessRunReapResult,
  reapConcludedRuns,
  reapJoblessRuns,
} from './runs-concluded.js';
import { detectStrandedIssues, type StrandedIssuesResult } from './stranded-issues.js';
import { emitPipelineWedge } from './wedge.js';

export const PIPELINE_SWEEPER_QUEUE = 'pipeline-sweeper';

const PIPELINE_METADATA_TYPES = sql`('pipeline','pm')`;

/** Back-compat shim — thresholds are owned by the loop monitor now (single
 *  source: same env names, same clamps). */
export function getZombieThresholds(): { queueMs: number; heartbeatMs: number } {
  const t = getLoopThresholds();
  return { queueMs: t.queueMs, heartbeatMs: t.heartbeatMs };
}

export interface ZombieSweepResult {
  // Counts are ALARMED rows (loop misses), not reaps — see module header.
  queueTimedOut: number;
  heartbeatTimedOut: number;
  noClientAcked: number;
}

export interface OrphanReconcileResult {
  reconciled: number;
}

export interface OneShotRunReapResult {
  reaped: number;
}

export interface IssueRunReapResult {
  // issue runs closed because their backing issue already reached a terminal status.
  reaped: number;
}

export interface IdleChatCloseResult {
  closed: number;
}

export interface StallDetectResult {
  // pipeline_wedge notifications emitted for never-clearing dependency deadlocks.
  detected: number;
}

export interface ClosedUnmergedAlarmResult {
  /** Dependents alarmed because their blocker closed without merging. */
  alerted: number;
}

export interface StaleReleaseBatchClaimsResult {
  released: number;
}

export interface SweepResult {
  durationMs: number;
  /** ISS-449 — the primary closed-loop pass (reaps). */
  loop: LoopMonitorResult;
  /** Demoted alarm passes (loop-miss counts, no writes). */
  zombieSessions: ZombieSweepResult;
  orphanedJobs: OrphanReconcileResult;
  neverClaimedDispatches: OrphanReconcileResult;
  orphanedOneShotRuns: OneShotRunReapResult;
  /** Chat sessions closed after CHAT_IDLE_CLOSE_MS of quiet (reaps). */
  idleChatSessions: IdleChatCloseResult;
  /** ISS-461 — issue runs closed because their backing issue is terminal (reaps). */
  orphanedIssueRuns: IssueRunReapResult;
  /** ISS-923 — runs closed because every child job already reached a terminal status (reaps). */
  concludedRuns: ConcludedRunReapResult;
  /** ISS-654 — issue runs closed because no job was ever enqueued under them (reaps). */
  joblessRuns: JoblessRunReapResult;
  /** RFC 0002 INV-7 — holds that outlived their threshold (alarm only). */
  agedHolds: Inv7AlarmResult;
  stalledQueuedJobs: Inv7AlarmResult;
  /** ISS-879 — steps queued behind a run that is paused (alarm only). */
  pausedRunsWithQueuedWork: Inv7AlarmResult;
  /** Runs at or past `noProgressRounds` in CONSECUTIVE review rejections (alarm only). */
  rejectionStreaks: Inv7AlarmResult;
  /** ISS-764 — batch release claims orphaned by a terminal run (claim-subscriber backstop). */
  staleReleaseBatchClaims: StaleReleaseBatchClaimsResult;
  /** ISS-762 — issues parked at `waiting` with merged code, surfaced to project admins. */
  strandedIssues: StrandedIssuesResult;
  orphanedPauses: OrphanedPauseResult;
  retryRescueThresholds: RetryRescueAlertResult;
  /** ISS-652 — Tier 1 ops alert engine push pass. */
  alerts: AlertSweepResult;
  queueSnapshots: number;
}

export async function runPipelineSweep(now: Date = new Date()): Promise<SweepResult> {
  const t0 = Date.now();

  // cm:why every pass is isolated rather than a bare sequential `await` chain — the first pass to throw used to abort the whole tick, which starved the run-axis reapers for days: `reapOrphanedOneShotRuns` never ran, and job-less `schedule.run` + chat `interactive` runs leaked `running` across EVERY project because no `jobs` row exists to close them (`VISION: state-never-lies`)
  const errors: Array<{ pass: string; err: unknown }> = [];
  const runPass = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      errors.push({ pass: name, err });
      logger.error(
        { err, pass: name },
        `pipeline-sweeper: pass '${name}' threw (isolated — remaining passes still run)`,
      );
      if (isSentryEnabled()) {
        Sentry.captureException(err, { tags: { area: 'pipeline-sweeper', sweep_pass: name } });
      }
      return undefined;
    }
  };

  // cm:guard the loop monitor runs FIRST and owns every reap; the alarm passes below must run against the POST-loop state, or a row they match is one the loop had not reached yet rather than a genuine miss, and every tick reports false wedges (ISS-449)
  const loop = await runPass('loopMonitor', () => runLoopMonitor(now));
  const zombieSessions = await runPass('alarmZombieSessions', () => alarmZombieSessions(now));
  const orphanedJobs = await runPass('alarmOrphanedJobs', () => alarmOrphanedJobs(now));
  const neverClaimedDispatches = await runPass('alarmNeverClaimedDispatches', () =>
    alarmNeverClaimedDispatches(now),
  );
  // cm:why an ACTIVE reaper, not dead code — `schedule.run` and chat `interactive` runs carry no `jobs` row, so the job loop never fires for them and a dead agent_session would leave them `running` forever (`VISION: state-never-lies`)
  const orphanedOneShotRuns = await runPass('reapOrphanedOneShotRuns', () =>
    reapOrphanedOneShotRuns(now),
  );
  const idleChatSessions = await runPass('closeIdleChatSessions', () => closeIdleChatSessions(now));
  const orphanedIssueRuns = await runPass('reapOrphanedIssueRuns', () =>
    reapOrphanedIssueRuns(now),
  );
  // cm:guard AFTER reapOrphanedIssueRuns, and the order carries meaning: that pass writes `completed` unconditionally to mirror `apply-transition.ts`, so running it first keeps the closed-issue case on its established outcome and leaves this pass the rows nothing else reaches. Reversed, a closed issue whose last job failed would start closing `failed` — a silent change to ISS-461's contract made by ordering alone.
  const concludedRuns = await runPass('reapConcludedRuns', () => reapConcludedRuns(now));
  // cm:guard AFTER reapConcludedRuns for the same ordering reason: that pass owns every run that HAS a job, this one only the rows with none, so a row can never be a candidate for both within one tick.
  const joblessRuns = await runPass('reapJoblessRuns', () => reapJoblessRuns(now));
  const agedHolds = await runPass('alarmAgedHolds', () => alarmAgedHolds(now));
  // cm:why alarm, not a reap: a plain `queued` job holds no capacity, so cancelling it frees nothing and only destroys work — and the state it reports (every gate passes, nothing started it) is one only a human can resolve, because the picker and the selector disagreeing is a configuration mismatch, not a stuck row
  const stalledQueuedJobs = await runPass('alarmStalledQueuedJobs', () =>
    alarmStalledQueuedJobs(now),
  );
  // cm:why the pass above cannot cover this and widening it would not help: a job under a paused run reports gate `pipeline_run_not_running`, so it is excluded by the `gated.has()` test, not by that pass's `pr.status='running'` filter. Measured 2026-08-30, that left four triage jobs queued 38 days on qa-project with no surface anywhere able to say so.
  const pausedRunsWithQueuedWork = await runPass('alarmPausedRunsWithQueuedWork', () =>
    alarmPausedRunsWithQueuedWork(now),
  );
  // cm:why an ACTIVE reaper, not an alarm: a run paused by a mechanism this build no longer has is not a state anyone can act on — there is nothing left to clear the reason, so surfacing it would ask a human to do the resume every time
  const orphanedPauses = await runPass('resumeOrphanedPauses', () => resumeOrphanedPauses());
  // cm:guard the ONLY reader of `noProgressRounds` left. Its twin `alarmChurningIssues` counted TOTAL reopens, and `reopen_count` moves solely on entry into `reopen` — a transition this lane never performs, so ISS-895 deleted it rather than leaving an alarm frozen at 0. An alarm that cannot fire is worse than no alarm: it reads as evidence the condition is absent.
  const rejectionStreaks = await runPass('alarmRejectionStreaks', () => alarmRejectionStreaks());

  // cm:edge sideeffect -> packages/core/src/release-batch/claim-subscriber.ts — backstop for the pipelineRunStatusChanged hook: releases release_batch_run_id claims left behind if the subscriber threw or was skipped
  const staleReleaseBatchClaims = await runPass('reapStaleReleaseBatchClaims', () =>
    reapStaleReleaseBatchClaims(),
  );
  const strandedIssues = await runPass('detectStrandedIssues', () => detectStrandedIssues(now));
  const retryRescueThresholds = await runPass('detectRetryRescueThresholds', () =>
    detectRetryRescueThresholds(now),
  );
  const alerts = await runPass('alertSweep', () => runAlertSweep(now));
  // ISS-381 (2.2) — snapshot per-project queue depth.
  const queueSnapshots = await runPass('recordQueueSnapshots', () => recordQueueSnapshots());

  // Preserve the ISS-449 missed-tick contract: if ANY pass failed, do NOT
  // record a clean heartbeat — re-throw so `pgboss-health` still sees the
  // missed tick and pg-boss retries the (idempotent) tick. The difference from
  // the old code is purely ordering: every pass has already RUN this tick
  // before we surface the failure, so a single buggy pass can no longer starve
  // the reapers. Each error was logged + captured individually above; re-throw
  // the first so its original cause/message surfaces unchanged.
  if (errors.length > 0) {
    throw errors[0]?.err;
  }

  recordPipelineSweeperTick(t0);
  return {
    durationMs: Date.now() - t0,
    // Safe: reached only when `errors` is empty, i.e. every pass returned a value.
    loop: loop as LoopMonitorResult,
    zombieSessions: zombieSessions as ZombieSweepResult,
    orphanedJobs: orphanedJobs as OrphanReconcileResult,
    neverClaimedDispatches: neverClaimedDispatches as OrphanReconcileResult,
    orphanedOneShotRuns: orphanedOneShotRuns as OneShotRunReapResult,
    idleChatSessions: idleChatSessions as IdleChatCloseResult,
    orphanedIssueRuns: orphanedIssueRuns as IssueRunReapResult,
    concludedRuns: concludedRuns as ConcludedRunReapResult,
    joblessRuns: joblessRuns as JoblessRunReapResult,
    agedHolds: agedHolds as Inv7AlarmResult,
    stalledQueuedJobs: stalledQueuedJobs as Inv7AlarmResult,
    pausedRunsWithQueuedWork: pausedRunsWithQueuedWork as Inv7AlarmResult,
    rejectionStreaks: rejectionStreaks as Inv7AlarmResult,
    staleReleaseBatchClaims: staleReleaseBatchClaims as StaleReleaseBatchClaimsResult,
    strandedIssues: strandedIssues as StrandedIssuesResult,
    orphanedPauses: orphanedPauses as OrphanedPauseResult,
    retryRescueThresholds: retryRescueThresholds as RetryRescueAlertResult,
    alerts: alerts as AlertSweepResult,
    queueSnapshots: queueSnapshots as number,
  };
}

/**
 * ISS-639 — active counterpart to the blocks-gate fix in
 * `jobs/queued-gates.ts`: when a project's `mergeStates.baseBranch` IS
 * stampable, the gate no longer treats a `closed`+`merged_at IS NULL`
 * blocker as satisfying `blockedBy`, so a
 * dependent whose blocker closed without merging now just sits `queued`
 * forever instead of silently dispatching onto a base branch missing the
 * blocker's code (devbox ISS-2/ISS-4). This pass raises an ALARM on it: past
 * {@link STALL_GRACE_MS} (same grace window as `detectStalledDependencies` —
 * long enough for the ordinary close→`mark_merged` race to resolve on its
 * own), emit a wedge naming the unmerged blocker.
 * Skips projects whose base is structurally unstampable (manual/toggle-off)
 * — that is the legitimate `OR status='closed'` bypass the gate still
 * honors, so those dependents are left alone. Best-effort: never throws
 * (returns `{ parked: 0 }` on error); each row is isolated so one failure
 * doesn't block the rest.
 *
 * Since the close-time auto-stamp (issues/merged-at.ts markMergedOnClose,
 * getcontent 2026-07-13), every close through the state-machine writer (and
 * the GitHub mirror-close) stamps merged_at, so new closed-unmerged blockers
 * can no longer arise from normal operation. This pass stays as the backstop
 * for pre-existing rows and direct DB writes that bypass both paths.
 */

/**
 * ISS-381 (2.2) — write one `queue_snapshots` row per project that currently has
 * at least one active job (queued/dispatched/running). One grouped
 * INSERT...SELECT per tick; projects with no active jobs get no row (the read
 * gap-fills missing buckets as 0). Best-effort: never throws — a snapshot is
 * observability, not part of the dispatch path. Returns the rows written.
 *
 * `avg_wait_ms` is the mean current wait (now - queued_at) over jobs still
 * `queued` (NULL when none are queued). `queue_depth` counts `queued`;
 * `running_count` counts `dispatched`+`running`.
 */
async function recordQueueSnapshots(): Promise<number> {
  try {
    const rows = await db.execute<{ project_id: string }>(sql`
      INSERT INTO queue_snapshots (project_id, queue_depth, running_count, avg_wait_ms)
      SELECT project_id,
             count(*) FILTER (WHERE status = 'queued')::int AS queue_depth,
             count(*) FILTER (WHERE status IN ('dispatched', 'running'))::int AS running_count,
             avg(extract(epoch from (now() - queued_at)) * 1000.0)
               FILTER (WHERE status = 'queued')::bigint AS avg_wait_ms
      FROM jobs
      WHERE status IN ('queued', 'dispatched', 'running')
      GROUP BY project_id
      RETURNING project_id
    `);
    const written = Array.isArray(rows) ? rows.length : 0;
    if (written > 0) {
      logger.info({ written }, 'pipeline-sweeper: queue snapshots written');
    }
    return written;
  } catch (err) {
    logger.error({ err }, 'pipeline-sweeper: queue snapshot pass failed (skipped)');
    return 0;
  }
}

export type SweepScope = LoopScope;

type SessionAlarmRow = {
  id: string;
  project_id: string;
  pipeline_run_id: string | null;
};

/**
 * DEMOTED (ISS-449) — alarm-only mirror of the loop monitor's session hops
 * (claim queue-timeout / heartbeat-stale / no-client). Detection predicates
 * are kept in lockstep with `reapZombieSessions` (jobs/loop-monitor.ts); a
 * match here means the loop missed the row this tick. No terminal writes.
 *
 * For an actual scoped reap (the manual `/agent-sessions/sweep-zombies`
 * endpoint), call `reapZombieSessions` directly.
 */
export async function alarmZombieSessions(
  now: Date,
  scope: SweepScope = {},
): Promise<ZombieSweepResult> {
  const { queueMs, heartbeatMs } = getZombieThresholds();
  const queueCutoffIso = new Date(now.getTime() - queueMs).toISOString();
  const heartbeatCutoffIso = new Date(now.getTime() - heartbeatMs).toISOString();
  const projectClause = scope.projectId ? sql`AND s.project_id = ${scope.projectId}` : sql``;

  const queued = await db.execute<SessionAlarmRow>(sql`
    SELECT s.id, s.project_id, s.pipeline_run_id
    FROM agent_sessions s
    WHERE s.status = 'queued'
      AND ((s.dispatched_at IS NOT NULL AND s.dispatched_at < ${queueCutoffIso})
        OR (s.dispatched_at IS NULL AND s.created_at < ${queueCutoffIso}))
      AND s.metadata->>'type' IN ${PIPELINE_METADATA_TYPES}
      ${projectClause}
  `);

  const heartbeat = await db.execute<SessionAlarmRow>(sql`
    SELECT s.id, s.project_id, s.pipeline_run_id
    FROM agent_sessions s
    WHERE s.status = 'running'
      AND ((s.last_heartbeat_at IS NOT NULL AND s.last_heartbeat_at < ${heartbeatCutoffIso})
        OR (s.last_heartbeat_at IS NULL AND s.started_at IS NOT NULL
            AND s.started_at < ${heartbeatCutoffIso} AND s.updated_at < ${heartbeatCutoffIso})
        OR (s.last_heartbeat_at IS NULL AND s.started_at IS NULL
            AND s.updated_at < ${heartbeatCutoffIso} AND s.created_at < ${heartbeatCutoffIso}))
      AND s.metadata->>'type' IN ${PIPELINE_METADATA_TYPES}
      ${projectClause}
  `);

  const noClient = await db.execute<SessionAlarmRow>(sql`
    SELECT s.id, s.project_id, s.pipeline_run_id
    FROM agent_sessions s
    WHERE s.status = 'running'
      AND s.claude_session_id IS NULL
      AND COALESCE(s.metadata->>'type','') NOT IN ${PIPELINE_METADATA_TYPES}
      AND ((s.last_heartbeat_at IS NOT NULL AND s.last_heartbeat_at < ${heartbeatCutoffIso})
        OR (s.last_heartbeat_at IS NULL AND s.created_at < ${heartbeatCutoffIso}))
      ${projectClause}
  `);

  await alarmLoopMiss('claim', 'session', [...queued, ...noClient]);
  await alarmLoopMiss('heartbeat', 'session', [...heartbeat]);

  return {
    queueTimedOut: queued.length,
    heartbeatTimedOut: heartbeat.length,
    noClientAcked: noClient.length,
  };
}

type JobAlarmRow = {
  id: string;
  project_id: string;
  issue_id: string | null;
};

/**
 * DEMOTED (ISS-449) — alarm-only mirror of the loop monitor's session-lost
 * propagation (`reapSessionLostJobs`, was ISS-280 `reconcileOrphanedJobs`).
 */
export async function alarmOrphanedJobs(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<OrphanReconcileResult> {
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  // cm:edge lockstep -> packages/core/src/jobs/kill-gate.ts — a gated row deliberately survives the loop until killGraceMs() elapses; exclude it or every gate trips a false loop-miss
  const killGateCutoffIso = new Date(now.getTime() - killGraceMs()).toISOString();
  const candidates = await db.execute<JobAlarmRow>(sql`
    SELECT j.id, j.project_id, j.issue_id
    FROM jobs j
    JOIN agent_sessions s ON s.id = j.agent_session_id
    WHERE j.status IN ('dispatched', 'running')
      AND s.status IN ('failed', 'cancelled_stale')
      AND NOT EXISTS (
        SELECT 1 FROM job_events e
        WHERE e.job_id = j.id AND e.kind = 'result'
      )
      AND (j.kill_requested_at IS NULL OR j.kill_requested_at <= ${killGateCutoffIso})
      ${projectClause}
  `);

  await alarmLoopMiss('heartbeat', 'job', [...candidates]);
  return { reconciled: candidates.length };
}

/**
 * DEMOTED (ISS-449) — alarm-only mirror of the loop monitor's dispatch→ack
 * hop (`reapAckMisses`, was ISS-378 `reconcileNeverClaimedDispatches`). The
 * `acked_at IS NULL` term keeps the predicate in lockstep with the loop: an
 * ACKED job with no events is claimed-but-quiet, which is the result hop's
 * territory, not an ack miss.
 */
export async function alarmNeverClaimedDispatches(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<OrphanReconcileResult> {
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  const cutoffIso = new Date(now.getTime() - getLoopThresholds().ackMs).toISOString();
  const killGateCutoffIso = new Date(now.getTime() - killGraceMs()).toISOString();
  const candidates = await db.execute<JobAlarmRow>(sql`
    SELECT j.id, j.project_id, j.issue_id
    FROM jobs j
    WHERE j.status = 'dispatched'
      AND j.acked_at IS NULL
      AND j.dispatched_at IS NOT NULL
      AND j.dispatched_at < ${cutoffIso}
      AND NOT EXISTS (
        SELECT 1 FROM job_events e WHERE e.job_id = j.id
      )
      AND (j.kill_requested_at IS NULL OR j.kill_requested_at <= ${killGateCutoffIso})
      ${projectClause}
  `);

  await alarmLoopMiss('ack', 'job', [...candidates]);
  return { reconciled: candidates.length };
}

/** Shared alarm tail: log the loop miss + surface it as a wedge (the wedge
 *  emitter dedupes per entity, so a row stuck across ticks doesn't spam). */
async function alarmLoopMiss(
  hop: 'ack' | 'claim' | 'heartbeat' | 'result',
  entity: 'job' | 'session',
  rows: Array<SessionAlarmRow | JobAlarmRow>,
): Promise<void> {
  if (rows.length === 0) return;
  logger.warn({ hop, entity, ids: rows.map((r) => r.id) }, 'loop-miss');
  for (const row of rows) {
    await emitPipelineWedge({
      projectId: row.project_id,
      issueId: 'issue_id' in row ? row.issue_id : null,
      hop,
      entity,
      entityId: row.id,
      reason: `loop-miss: the ${hop} hop should have handled this ${entity} and did not (alarm pass match)`,
      action:
        'Inspect core logs around this tick for a thrown miss-handler; if the row is genuinely wedged, use the single-job cancel escape hatch (forge_jobs cancel).',
    });
  }
}

/**
 * ISS-445 — close job-less `system`/`interactive` runs whose session is dead.
 *
 * schedule.run and interactive chat open a one-shot run via `openOneShotRun`
 * and execute it over an `agent:start` WS broadcast to the device room — they
 * create NO `jobs` row, so the `agent_session` IS the unit of work. The only
 * existing close paths are session/job-terminal events: the device POSTing
 * `/agent-sessions/desktop/status` (→ `closeRunIfOneShot`) and the job
 * lifecycle (`jobs/agent-session-link.ts`). When an unattended device finishes
 * the turn but never reports terminal status (the dominant schedule.run case),
 * both the session AND the run stay `running` forever — the loop monitor's
 * session hops don't catch it (claim/heartbeat are gated to
 * `metadata.type IN (pipeline,pm)`; the no-client hop only reaps
 * `claude_session_id IS NULL`), and `cascadeCancelChildJobs` keys
 * session-terminal off linked *jobs*, of which there are none.
 *
 * This pass is the backstop: a run is reapable when it is a job-less
 * `system`/`interactive` run older than the heartbeat threshold (age guard so
 * a freshly-opened run is never touched) with NO live session. A session counts
 * as live when its heartbeat is fresh within the bare heartbeat floor, OR
 * (ISS-442 device-aware grace) within a longer grace window while its device is
 * still beating on the runner WS — so a long-but-alive agent that goes quiet
 * between worker-side writes (parallel subagents) is not force-failed. Any
 * lingering non-terminal session is force-failed (`heartbeat_timeout`) and
 * broadcast first, then the run is closed through the shared
 * `closeRunIfOneShot` SSOT (CAS-guarded; cascade is a no-op with zero jobs).
 *
 * Outcome honesty: `completed` only when a session genuinely reached a
 * completed terminal and none failed (the missed-`/desktop/status` case);
 * otherwise `failed` — never the false-`completed` mirror of ISS-352. The pass
 * also drains the existing leaked backlog on the first ticks after deploy
 * (their heartbeats are days stale), so no one-shot migration is needed.
 *
 * Best-effort per row: one failure is logged and skipped, never aborting the
 * pass — same convention as the loop monitor's per-row handlers.
 */
export async function reapOrphanedOneShotRuns(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<OneShotRunReapResult> {
  const { heartbeatMs } = getZombieThresholds();
  // postgres-js rejects raw Date params; serialise to ISO before binding.
  const cutoffIso = new Date(now.getTime() - heartbeatMs).toISOString();
  // ISS-442 — a job-less agent (esp. a schedule audit fanning out parallel
  // subagents) can go many minutes between worker-side writes while genuinely
  // alive, so the bare 3-min heartbeat floor force-failed LIVE runs (the run
  // closed mid-work; the still-running session was then orphaned by the
  // terminal-run trigger). Add a device-aware grace: a session whose heartbeat
  // is within DEVICE_GRACE *and* whose device is still beating on the runner WS
  // (`runners.last_seen_at` fresh) counts as live. A dead/disconnected device
  // still reaps on the bare heartbeat floor; a truly abandoned session reaps
  // once even the grace lapses.
  const deviceGraceMs = Math.max(heartbeatMs, 20 * 60_000);
  const graceCutoffIso = new Date(now.getTime() - deviceGraceMs).toISOString();
  const projectClause = scope.projectId ? sql`AND r.project_id = ${scope.projectId}` : sql``;

  const candidates = await db.execute<{ id: string }>(sql`
    SELECT r.id
    FROM pipeline_runs r
    WHERE r.kind IN ('system', 'interactive')
      AND r.status IN ('running', 'paused')
      AND r.started_at < ${cutoffIso}
      AND NOT EXISTS (
        SELECT 1 FROM jobs j WHERE j.pipeline_run_id = r.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM agent_sessions s
        WHERE s.pipeline_run_id = r.id
          AND s.status IN ('queued', 'running', 'idle')
          AND (
            COALESCE(s.last_heartbeat_at, s.started_at, s.updated_at, s.created_at) >= ${cutoffIso}
            OR (
              COALESCE(s.last_heartbeat_at, s.started_at, s.updated_at, s.created_at) >= ${graceCutoffIso}
              AND EXISTS (
                SELECT 1 FROM runners rn
                WHERE rn.device_id = s.device_id
                  AND rn.last_seen_at >= ${cutoffIso}
              )
            )
          )
      )
      ${projectClause}
    ORDER BY r.started_at ASC
    LIMIT 200
  `);

  let reaped = 0;
  for (const row of candidates) {
    try {
      // Force-fail any lingering non-terminal session for this run. A session
      // already completed/failed is left as-is — the run still needs closing
      // (the missed-`/desktop/status` case).
      const flipped = await applyKernelTransition(db, {
        entity: 'session',
        to: 'failed',
        set: { failureReason: 'heartbeat_timeout', updatedAt: now },
        where: and(
          eq(agentSessions.pipelineRunId, row.id),
          inArray(agentSessions.status, ['queued', 'running', 'idle']),
        ),
        fromStatus: 'active',
        reason: 'heartbeat_timeout',
        actor: { type: 'sweeper' },
        source: 'sweeper',
      });
      for (const s of flipped) {
        broadcastSessionEvent(s.id, s.projectId, s.deviceId, 'agent-session.status', {
          status: 'failed',
          failureReason: 'heartbeat_timeout',
        });
      }

      // Derive the run outcome from the post-flip session statuses: a genuine
      // success-close (`completed`) only when some session reached a completed
      // terminal and none is failed/cancelled_stale; otherwise `failed`.
      const sessions = await db
        .select({ status: agentSessions.status })
        .from(agentSessions)
        .where(eq(agentSessions.pipelineRunId, row.id));
      const anyCompleted = sessions.some(
        (s) => s.status === 'completed' || s.status === 'completed_via_recovery',
      );
      const anyFailed = sessions.some(
        (s) => s.status === 'failed' || s.status === 'cancelled_stale',
      );
      const outcome: 'completed' | 'failed' = anyCompleted && !anyFailed ? 'completed' : 'failed';

      await closeRunIfOneShot(row.id, outcome);
      reaped++;
    } catch (err) {
      logger.error(
        { err, runId: row.id },
        'pipeline-sweeper: orphaned one-shot run reap failed (row skipped)',
      );
    }
  }

  if (reaped > 0) {
    logger.info({ reaped }, 'pipeline-sweeper: orphaned one-shot runs closed');
  }

  return { reaped };
}

/**
 * Close chat sessions that have gone quiet, instead of leaving them live.
 *
 * Resuming is free — the row keeps `claude_session_id`, so the next turn revives
 * the session and `--resume` carries the conversation — while a session left
 * live for many hours answers from a workspace nothing refreshed. Measured on
 * session `228cdf03` (ceo-dashboard): live for 28h, then produced a release
 * advisory in which 6 of 7 claims were false, because its checkout predated by
 * 2.5h the merge it was asked about.
 *
 * Deliberately independent of the run's status, so a quiet session under a run
 * that never closed is covered too — `reapOrphanedOneShotRuns` only looks at
 * runs still `running`/`paused`, and the terminal-run trigger only labels.
 */
export const CHAT_IDLE_CLOSE_MS = 2 * 60 * 60_000;

export async function closeIdleChatSessions(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<IdleChatCloseResult> {
  // postgres-js rejects raw Date params; serialise to ISO before binding.
  const cutoffIso = new Date(now.getTime() - CHAT_IDLE_CLOSE_MS).toISOString();
  const projectClause = scope.projectId ? sql`AND s.project_id = ${scope.projectId}` : sql``;

  // cm:guard never widen this SELECT to job-linked or `schedule.run` sessions. A job-linked session belongs to the loop monitor, and closing one here races its owner. A hung `schedule.run` closed `completed` makes the next terminal report write `schedules.lastStatus='success'` (schedules/service.ts) — a lie about an audit that never ran, which is the exact class this pass exists to prevent.
  // cm:guard `started_at IS NOT NULL` — a row that never ran has nothing to close honestly; `idle` is also the DEFAULT status of a fresh session, so without this the pass would settle never-dispatched rows as `completed`.
  const candidates = await db.execute<{ id: string }>(sql`
    SELECT s.id
    FROM agent_sessions s
    WHERE s.status IN ('queued', 'running', 'idle')
      AND s.started_at IS NOT NULL
      AND COALESCE(s.last_heartbeat_at, s.started_at, s.updated_at, s.created_at) < ${cutoffIso}
      AND COALESCE(s.metadata->>'source', '') <> 'schedule.run'
      AND NOT EXISTS (
        SELECT 1 FROM jobs j WHERE j.agent_session_id = s.id
      )
      ${projectClause}
    ORDER BY s.updated_at ASC
    LIMIT 200
  `);

  const ids = candidates.map((row) => row.id);
  if (ids.length === 0) return { closed: 0 };

  // cm:edge lockstep -> packages/core/src/agent-sessions/routes.ts — fourth writer of the completed-carries-no-reason contract (ISS-759)
  const flipped = await applyKernelTransition(db, {
    entity: 'session',
    to: 'completed',
    set: { failureReason: null, failureDetail: null, updatedAt: now },
    where: and(
      inArray(agentSessions.id, ids),
      inArray(agentSessions.status, ['queued', 'running', 'idle']),
    ),
    fromStatus: 'active',
    reason: 'chat_idle_timeout',
    actor: { type: 'sweeper' },
    source: 'sweeper',
  });

  for (const s of flipped) {
    broadcastSessionEvent(s.id, s.projectId, s.deviceId, 'agent-session.status', {
      status: 'completed',
    });
  }
  if (flipped.length > 0) {
    logger.info({ closed: flipped.length }, 'pipeline-sweeper: idle chat sessions closed');
  }
  return { closed: flipped.length };
}

/**
 * ISS-461 — close `issue`-kind runs left `running`/`paused` after their backing
 * issue already reached a run-closing status (ISS-669 removed `released` from
 * that set — the release step runs inside the still-open run).
 *
 * `closeOpenRunForIssue` is wired in exactly one place — `apply-transition.ts`'s
 * `RUN_CLOSING_STATUSES` block — so a close-status write that bypasses
 * `applyTransition` (or a close predating that wiring) orphans the issue run: it
 * stays `running`/`paused` forever, and none of the other reapers cover
 * `kind='issue'` (`reapOrphanedOneShotRuns` is scoped to `system`/`interactive`).
 * The dashboard live-run count (`derive.ts liveRuns()`) renders every
 * `running`/`paused` run, so each leak inflates it.
 *
 * Run-axis backstop (sibling of `reapOrphanedOneShotRuns`): it closes each
 * candidate through the shared SSOT `closeOpenRunForIssue` (CAS-guarded on
 * `status IN (running,paused)`, sets `finishedAt`, cascades child-job cancel,
 * emits the close hook). Outcome `'completed'` mirrors `apply-transition.ts`,
 * which passes `'completed'` on `closed` — never a false `failed`. The age
 * guard (`started_at` older than the heartbeat threshold)
 * avoids racing a just-fired `applyTransition` close, and also drains the
 * existing leaked backlog on the first ticks after deploy (their `started_at`
 * is days old) — no one-shot migration needed.
 *
 * Best-effort per row: one failure is logged and skipped, never aborting the
 * pass — same convention as `reapOrphanedOneShotRuns`.
 */
// cm:edge lockstep -> packages/core/src/issues/apply-transition.ts — the status list in this query IS `RUN_CLOSING_STATUSES`, and this pass is that block's only backstop; a status added there and not here leaks its runs forever with no reaper on any axis. `dropped` was exactly that drift (2026-08-30), and it is not hypothetical on an autonomous project — `dropped` is one of the five statuses the driver may write.
export async function reapOrphanedIssueRuns(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<IssueRunReapResult> {
  const { heartbeatMs } = getZombieThresholds();
  // postgres-js rejects raw Date params; serialise to ISO before binding.
  const cutoffIso = new Date(now.getTime() - heartbeatMs).toISOString();
  const projectClause = scope.projectId ? sql`AND r.project_id = ${scope.projectId}` : sql``;

  const candidates = await db.execute<{ id: string; issue_id: string }>(sql`
    SELECT r.id, r.issue_id
    FROM pipeline_runs r
    JOIN issues i ON i.id = r.issue_id
    WHERE r.kind = 'issue'
      AND r.status IN ('running', 'paused')
      AND i.status IN ('closed', 'dropped')
      AND r.started_at < ${cutoffIso}
      ${projectClause}
    ORDER BY r.started_at ASC
    LIMIT 200
  `);

  let reaped = 0;
  for (const row of candidates) {
    try {
      // cm:guard count only what actually closed — `closeOpenRunForIssue` returns `deferred` while a dispatched deploy is unconfirmed (ISS-922); the run is revisited next tick and closes on the deploy's real outcome.
      if ((await closeOpenRunForIssue(row.issue_id, 'completed')) === 'settled') reaped++;
    } catch (err) {
      logger.error(
        { err, runId: row.id, issueId: row.issue_id },
        'pipeline-sweeper: orphaned issue-run reap failed (row skipped)',
      );
    }
  }

  if (reaped > 0) {
    logger.info({ reaped }, 'pipeline-sweeper: orphaned issue runs closed');
  }

  return { reaped };
}

/**
 * ISS-764 — backstop for orphaned release_batch claims.
 *
 * The primary claim release is the `registerReleaseBatchClaimSubscriber` hook
 * on `pipelineRunStatusChanged`. This pass is the fallback: find issues whose
 * `release_batch_run_id` references a terminal (non-running, non-paused) run
 * and clear the pointer. Best-effort: never throws; a residual is safe — it
 * just means the issue stays un-selectable until the next tick.
 */
export async function reapStaleReleaseBatchClaims(): Promise<StaleReleaseBatchClaimsResult> {
  try {
    const released = await db.execute<{ id: string }>(sql`
      UPDATE issues
      SET release_batch_run_id = NULL, updated_at = now()
      WHERE release_batch_run_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pipeline_runs r
          WHERE r.id = issues.release_batch_run_id
            AND r.status NOT IN ('running', 'paused')
        )
      RETURNING id
    `);
    const count = Array.isArray(released) ? released.length : 0;
    if (count > 0) {
      logger.info({ count }, 'pipeline-sweeper: stale release-batch claims cleared');
    }
    return { released: count };
  } catch (err) {
    logger.error({ err }, 'pipeline-sweeper: stale release-batch claim reap failed (skipped)');
    return { released: 0 };
  }
}

let registered = false;

export async function registerPipelineSweeper(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).createQueue(PIPELINE_SWEEPER_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).work(PIPELINE_SWEEPER_QUEUE, async () => {
    try {
      await runPipelineSweep();
    } catch (err) {
      logger.error({ err }, 'pipeline-sweeper: tick failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).schedule(PIPELINE_SWEEPER_QUEUE, '* * * * *'); // every minute
  registered = true;
}

export function resetPipelineSweeperForTest(): void {
  registered = false;
}
