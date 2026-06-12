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
 * perform NO terminal writes. Because they run in the same tick right AFTER
 * the loop, any row they still match is a row the loop should have handled
 * and didn't — a loop MISS, logged as `loop-miss` and surfaced as a
 * `pipeline_wedge` (coverage proof during the cutover; the alarm passes are
 * deleted at the ISS-442 parent integration once the loop is proven).
 *
 * Still active here (not part of the demoted four):
 *
 *  - One-shot run reaper (ISS-445) — closes job-less system/interactive runs
 *    whose backing session is dead. Run-axis, not modeled by the job loop.
 *  - Dispatcher backstop — re-tick `dispatchTickForProject` for every project
 *    that has queued jobs. Event-driven triggers are best-effort and can miss
 *    under race conditions; the backstop guarantees queued jobs are
 *    re-evaluated at least once per minute. `pgboss-health` monitors the
 *    schedule and alerts when this tick stops firing.
 *  - Queue snapshots (ISS-381) — per-project queue-depth observability.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, jobs } from '../db/schema.js';
import { broadcastSessionEvent } from '../jobs/agent-session-link.js';
import { dispatchTickForProject } from '../jobs/dispatch-tick.js';
import {
  type LoopMonitorResult,
  type LoopScope,
  getLoopThresholds,
  runLoopMonitor,
} from '../jobs/loop-monitor.js';
import { recordPipelineSweeperTick } from '../jobs/pgboss-health.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { closeRunIfOneShot } from './runs.js';
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
  // job-less system/interactive runs closed because no live session remained.
  reaped: number;
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
  backstopProjects: number;
  queueSnapshots: number;
}

export async function runPipelineSweep(now: Date = new Date()): Promise<SweepResult> {
  const t0 = Date.now();
  // ISS-449 — the loop monitor runs FIRST and owns every reap. The alarm
  // passes below run against the post-loop state, so anything they match is a
  // genuine loop miss (handler threw, CAS starved, coverage gap) — not a row
  // the loop simply hadn't reached yet.
  const loop = await runLoopMonitor(now);
  const zombieSessions = await alarmZombieSessions(now);
  const orphanedJobs = await alarmOrphanedJobs(now);
  const neverClaimedDispatches = await alarmNeverClaimedDispatches(now);
  // ISS-445 — close job-less system/interactive runs (schedule.run + chat)
  // whose backing agent_session is no longer live. These runs carry no `jobs`
  // row, so the job loop never fires for them and they would leak `running`
  // forever (VISION §5.10 "state never lies"). Still an ACTIVE reaper.
  const orphanedOneShotRuns = await reapOrphanedOneShotRuns(now);
  const backstopProjects = await runDispatcherBackstop();
  // ISS-381 (2.2) — snapshot per-project queue depth. Best-effort: a failure
  // here must never abort the tick or block the heartbeat below.
  const queueSnapshots = await recordQueueSnapshots();
  // Record the heartbeat ONLY after every pass succeeded. Recording at the
  // top would leave `pgboss-health` blind to a silent backstop failure
  // (lastTickAt fresh, dispatcher.tick_missing never fires). Letting either
  // pass throw lets pg-boss retry and pgboss-health alert.
  recordPipelineSweeperTick(t0);
  return {
    durationMs: Date.now() - t0,
    loop,
    zombieSessions,
    orphanedJobs,
    neverClaimedDispatches,
    orphanedOneShotRuns,
    backstopProjects,
    queueSnapshots,
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

/**
 * Re-tick `dispatchTickForProject` for every project with at least one
 * queued job. Returns the count of projects observed (not ticks completed —
 * `dispatchTickForProject` debounces per project so a recently-fired event
 * trigger may coalesce this call into a no-op). Errors propagate to the
 * caller so the failure is visible to `pgboss-health` instead of swallowed.
 */
async function runDispatcherBackstop(): Promise<number> {
  const rows = await db
    .selectDistinct({ projectId: jobs.projectId })
    .from(jobs)
    .where(eq(jobs.status, 'queued'));
  for (const r of rows) {
    void dispatchTickForProject(r.projectId);
  }
  return rows.length;
}

type SweepScope = LoopScope;

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
  _now: Date = new Date(),
  scope: SweepScope = {},
): Promise<OrphanReconcileResult> {
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
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
 * a freshly-opened run is never touched) with NO live session — i.e. no linked
 * session in `queued|running|idle` whose heartbeat is still fresh. Any
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
          AND COALESCE(s.last_heartbeat_at, s.started_at, s.updated_at, s.created_at) >= ${cutoffIso}
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
