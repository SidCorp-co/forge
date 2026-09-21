import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
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
import { parkedOnAHuman } from '../jobs/park-deadline.js';
import { recordPipelineSweeperTick } from '../jobs/pgboss-health.js';
import { CLIENT_SESSION_KINDS, kindTuple, PIPELINE_SESSION_KINDS } from '../jobs/session-kinds.js';
import { LIVE_SESSION_STATUSES } from '../lifecycle/status-sets.js';
import { applyKernelTransition, SWEEP_SESSION_COLUMNS } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { boss } from '../queue/boss.js';
import { type IdleIssuesResult, reconcileIdleIssues } from './idle-issues.js';
import {
  alarmAgedHolds,
  alarmPausedRunsWithQueuedWork,
  alarmRejectionStreaks,
  alarmStalledQueuedJobs,
  type Inv7AlarmResult,
} from './inv7-alarms.js';
import {
  detectOrphanedRunAssertions,
  type IssueRunInvariantResult,
} from './issue-run-invariant.js';
import { type ReevaluateResult, reevaluateConditions } from './reevaluate-conditions.js';
import { detectRetryRescueThresholds, type RetryRescueAlertResult } from './retry-rescue-alert.js';
import { type OrphanedPauseResult, resumeOrphanedPauses } from './run-pause.js';
import {
  nameOverdueRunnerReleases,
  type RunnerReleaseDeadlineResult,
} from './runner-release-deadline.js';
import { closeOpenRunForIssue, closeRunIfOneShot } from './runs.js';
import {
  type ConcludedRunReapResult,
  type JoblessRunReapResult,
  reapConcludedRuns,
  reapJoblessRuns,
} from './runs-concluded.js';
import {
  detectOwedCloses,
  detectStrandedIssues,
  type StrandedIssuesResult,
} from './stranded-issues.js';
import { emitPipelineWedge } from './wedge.js';

export const PIPELINE_SWEEPER_QUEUE = 'pipeline-sweeper';

/** Back-compat shim — thresholds are owned by the loop monitor now (single
 *  source: same env names, same clamps). */
export function getZombieThresholds(): { queueMs: number; heartbeatMs: number } {
  const t = getLoopThresholds();
  return { queueMs: t.queueMs, heartbeatMs: t.heartbeatMs };
}

export interface ZombieSweepResult {
  queueTimedOut: number;
  turnNeverReported: number;
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
  reaped: number;
}

export interface IdleChatCloseResult {
  closed: number;
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
  concludedRuns: ConcludedRunReapResult;
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
  /** ISS-1050 — issues asserting work in progress with no live run behind them (report only). */
  orphanedRunAssertions: IssueRunInvariantResult;
  /** ISS-1122 — non-terminal issues with nothing working them, named on the row itself. */
  idleIssues: IdleIssuesResult;
  /** ISS-762 — issues parked at `waiting` with merged code, surfaced to project admins. */
  strandedIssues: StrandedIssuesResult;
  owedCloses: StrandedIssuesResult;
  orphanedPauses: OrphanedPauseResult;
  retryRescueThresholds: RetryRescueAlertResult;
  /** ISS-1075 — runner releases past their own deadline, named with what is true on the repository. */
  overdueRunnerReleases: RunnerReleaseDeadlineResult;
  /** ISS-1063 — conditions re-derived: resolved, inhibited children released, stale pending dropped. */
  reevaluated: ReevaluateResult;
  /** ISS-652 — Tier 1 ops alert engine push pass. */
  alerts: AlertSweepResult;
  queueSnapshots: number;
}

export async function runPipelineSweep(now: Date = new Date()): Promise<SweepResult> {
  const t0 = Date.now();

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

  const loop = await runPass('loopMonitor', () => runLoopMonitor(now));
  const zombieSessions = await runPass('alarmZombieSessions', () => alarmZombieSessions(now));
  const orphanedJobs = await runPass('alarmOrphanedJobs', () => alarmOrphanedJobs(now));
  const neverClaimedDispatches = await runPass('alarmNeverClaimedDispatches', () =>
    alarmNeverClaimedDispatches(now),
  );
  const orphanedOneShotRuns = await runPass('reapOrphanedOneShotRuns', () =>
    reapOrphanedOneShotRuns(now),
  );
  const idleChatSessions = await runPass('closeIdleChatSessions', () => closeIdleChatSessions(now));
  const orphanedIssueRuns = await runPass('reapOrphanedIssueRuns', () =>
    reapOrphanedIssueRuns(now),
  );
  const concludedRuns = await runPass('reapConcludedRuns', () => reapConcludedRuns(now));
  const joblessRuns = await runPass('reapJoblessRuns', () => reapJoblessRuns(now));
  const agedHolds = await runPass('alarmAgedHolds', () => alarmAgedHolds(now));
  const stalledQueuedJobs = await runPass('alarmStalledQueuedJobs', () =>
    alarmStalledQueuedJobs(now),
  );
  const pausedRunsWithQueuedWork = await runPass('alarmPausedRunsWithQueuedWork', () =>
    alarmPausedRunsWithQueuedWork(now),
  );
  const orphanedPauses = await runPass('resumeOrphanedPauses', () => resumeOrphanedPauses());
  const rejectionStreaks = await runPass('alarmRejectionStreaks', () => alarmRejectionStreaks());

  const staleReleaseBatchClaims = await runPass('reapStaleReleaseBatchClaims', () =>
    reapStaleReleaseBatchClaims(),
  );
  const orphanedRunAssertions = await runPass('detectOrphanedRunAssertions', () =>
    detectOrphanedRunAssertions(now),
  );
  const overdueRunnerReleases = await runPass('nameOverdueRunnerReleases', () =>
    nameOverdueRunnerReleases(now),
  );
  const idleIssues = await runPass('reconcileIdleIssues', () => reconcileIdleIssues(now));
  const strandedIssues = await runPass('detectStrandedIssues', () => detectStrandedIssues(now));
  const owedCloses = await runPass('detectOwedCloses', () => detectOwedCloses(now));
  const retryRescueThresholds = await runPass('detectRetryRescueThresholds', () =>
    detectRetryRescueThresholds(now),
  );
  const reevaluated = await runPass('reevaluateConditions', () => reevaluateConditions(now));
  const alerts = await runPass('alertSweep', () => runAlertSweep(now));
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
    orphanedRunAssertions: orphanedRunAssertions as IssueRunInvariantResult,
    idleIssues: idleIssues as IdleIssuesResult,
    strandedIssues: strandedIssues as StrandedIssuesResult,
    owedCloses: owedCloses as StrandedIssuesResult,
    orphanedPauses: orphanedPauses as OrphanedPauseResult,
    retryRescueThresholds: retryRescueThresholds as RetryRescueAlertResult,
    overdueRunnerReleases: overdueRunnerReleases as RunnerReleaseDeadlineResult,
    reevaluated: reevaluated as ReevaluateResult,
    alerts: alerts as AlertSweepResult,
    queueSnapshots: queueSnapshots as number,
  };
}

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
 * are kept in lockstep with `reapZombieSessions` (jobs/loop-monitor.ts) and
 * with the two queue arms it calls (jobs/queue-hop.ts); a
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
      AND s.last_heartbeat_at IS NULL
      AND ((s.dispatched_at IS NOT NULL AND s.dispatched_at < ${queueCutoffIso})
        OR (s.dispatched_at IS NULL AND s.created_at < ${queueCutoffIso}))
      AND s.kind IN ${kindTuple(PIPELINE_SESSION_KINDS)}
      ${projectClause}
  `);

  const neverReported = await db.execute<SessionAlarmRow>(sql`
    SELECT s.id, s.project_id, s.pipeline_run_id
    FROM agent_sessions s
    WHERE s.status = 'queued'
      AND s.last_heartbeat_at IS NOT NULL
      AND s.last_heartbeat_at < ${heartbeatCutoffIso}
      AND s.kind IN ${kindTuple(PIPELINE_SESSION_KINDS)}
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
      AND s.kind IN ${kindTuple(PIPELINE_SESSION_KINDS)}
      ${projectClause}
  `);

  const noClient = await db.execute<SessionAlarmRow>(sql`
    SELECT s.id, s.project_id, s.pipeline_run_id
    FROM agent_sessions s
    WHERE s.status = 'running'
      AND s.claude_session_id IS NULL
      AND s.kind IN ${kindTuple(CLIENT_SESSION_KINDS)}
      AND ((s.last_heartbeat_at IS NOT NULL AND s.last_heartbeat_at < ${heartbeatCutoffIso})
        OR (s.last_heartbeat_at IS NULL AND s.created_at < ${heartbeatCutoffIso}))
      ${projectClause}
  `);

  await alarmLoopMiss('claim', 'session', [...queued, ...noClient]);
  await alarmLoopMiss('heartbeat', 'session', [...heartbeat, ...neverReported]);

  return {
    queueTimedOut: queued.length,
    turnNeverReported: neverReported.length,
    heartbeatTimedOut: heartbeat.length,
    noClientAcked: noClient.length,
  };
}

type JobAlarmRow = {
  id: string;
  project_id: string;
  issue_id: string | null;
};

export function orphanedJobAlarmQuery(now: Date = new Date(), scope: SweepScope = {}): SQL {
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  const killGateCutoffIso = new Date(now.getTime() - killGraceMs()).toISOString();
  return sql`
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
  `;
}

export async function alarmOrphanedJobs(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<OrphanReconcileResult> {
  const candidates = await db.execute<JobAlarmRow>(orphanedJobAlarmQuery(now, scope));

  await alarmLoopMiss('heartbeat', 'job', [...candidates]);
  return { reconciled: candidates.length };
}

export function neverClaimedAlarmQuery(now: Date = new Date(), scope: SweepScope = {}): SQL {
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  const cutoffIso = new Date(now.getTime() - getLoopThresholds().ackMs).toISOString();
  const killGateCutoffIso = new Date(now.getTime() - killGraceMs()).toISOString();
  return sql`
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
  `;
}

export async function alarmNeverClaimedDispatches(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<OrphanReconcileResult> {
  const candidates = await db.execute<JobAlarmRow>(neverClaimedAlarmQuery(now, scope));

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

export async function reapOrphanedOneShotRuns(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<OneShotRunReapResult> {
  const { heartbeatMs } = getZombieThresholds();
  const cutoffIso = new Date(now.getTime() - heartbeatMs).toISOString();
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
            OR ${parkedOnAHuman(sql`s.id`)}
          )
      )
      ${projectClause}
    ORDER BY r.started_at ASC
    LIMIT 200
  `);

  let reaped = 0;
  for (const row of candidates) {
    try {
      // A session already completed or failed is left as-is — the run still
      // needs closing (the missed-`/desktop/status` case).
      const flipped = await applyKernelTransition(db, {
        entity: 'session',
        returning: SWEEP_SESSION_COLUMNS,
        to: 'failed',
        set: { failureReason: 'heartbeat_timeout', updatedAt: now },
        where: and(
          eq(agentSessions.pipelineRunId, row.id),
          inArray(agentSessions.status, LIVE_SESSION_STATUSES),
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
  const cutoffIso = new Date(now.getTime() - CHAT_IDLE_CLOSE_MS).toISOString();
  const projectClause = scope.projectId ? sql`AND s.project_id = ${scope.projectId}` : sql``;

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

  const flipped = await applyKernelTransition(db, {
    entity: 'session',
    returning: SWEEP_SESSION_COLUMNS,
    to: 'completed',
    set: { failureReason: null, failureDetail: null, updatedAt: now },
    where: and(
      inArray(agentSessions.id, ids),
      inArray(agentSessions.status, LIVE_SESSION_STATUSES),
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

export async function reapOrphanedIssueRuns(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<IssueRunReapResult> {
  const { heartbeatMs } = getZombieThresholds();
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
  await (boss as any).schedule(PIPELINE_SWEEPER_QUEUE, '* * * * *');
  registered = true;
}

export function resetPipelineSweeperForTest(): void {
  registered = false;
}
