/**
 * Pipeline self-healing sweeper — zombie session cleanup + dispatcher backstop.
 *
 * Previously this file also handled multi-tier "stuck issue" recovery
 * (re-enqueue + recoveryAttempts budget + pipeline_failed escalation) and an
 * expired-hold auto-clear pass. ISS-393 removed the manualHold model: the
 * shared finalize path (`finalizeFailedJob`) now reverts a failed job's issue
 * to its stage entry-status (retry) or parks it at `waiting` (exhausted), so
 * there is no hold to clear here anymore.
 *
 * Each 60s tick performs two best-effort passes:
 *
 *  1. Zombie sessions — fail agent_sessions abandoned by their worker
 *     (queue_timeout / heartbeat_timeout). Observability rows; flipping
 *     them to `failed` clears the UI's "running" spinner without
 *     operator action. No job/issue state is mutated by this pass.
 *
 *  2. Dispatcher backstop — re-tick `dispatchTickForProject` for every
 *     project that has queued jobs. Event-driven triggers (job complete,
 *     runner online flip, issue transition) are best-effort and can miss
 *     under race conditions (worker disconnect mid-flight, stale-detector
 *     timing window). The backstop guarantees queued jobs are re-evaluated
 *     against current runner state at least once per minute. `pgboss-health`
 *     monitors the schedule and alerts when this tick stops firing.
 */

import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, jobs } from '../db/schema.js';
import { broadcastSessionEvent } from '../jobs/agent-session-link.js';
import { dispatchTickForProject } from '../jobs/dispatch-tick.js';
import { finalizeFailedJob } from '../jobs/finalize-failure.js';
import { recordPipelineSweeperTick } from '../jobs/pgboss-health.js';
import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import { boss } from '../queue/boss.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

export const PIPELINE_SWEEPER_QUEUE = 'pipeline-sweeper';

// Zombie thresholds clamp at MIN_TIMEOUT_MS so a low env override can't
// slaughter healthy sessions (a 10s heartbeat threshold would).
//
// ISS-232 Phase 3 — queue timeout cut from 5 min to 2 min. Pairs with the
// v2 selector's deterministic primary-pinned behaviour: a job that hasn't
// been claimed by its assigned runner within 2 minutes is almost certainly
// a worker death, and surfacing that faster lets the picker re-tick onto
// standby (or surface as `queue_timeout`) without leaving the issue
// invisible for another 3 minutes.
const QUEUE_TIMEOUT_MS_DEFAULT = 120_000;
const HEARTBEAT_TIMEOUT_MS_DEFAULT = 3 * 60_000;
const MIN_TIMEOUT_MS = 30_000;

// ISS-378 — a `dispatched` job that NEVER received a runner ack (zero
// job_events, not even `started`) past this grace window is reaped fast. This
// is distinct from runStaleSweep's 60-min quiet backstop, which covers a job
// that DID start and went silent between event emissions (legit heavy work can
// pause >5min). A `dispatched` job with zero events means the assigned runner
// never claimed it, and a live runner claims within seconds — so 60min is far
// too slow. Clamped at MIN_TIMEOUT_MS like the zombie thresholds.
const NEVER_CLAIMED_MS_DEFAULT = 3 * 60_000;

const PIPELINE_METADATA_TYPES = sql`('pipeline','pm')`;

function readTimeoutEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_TIMEOUT_MS ? n : fallback;
}

export function getZombieThresholds(): { queueMs: number; heartbeatMs: number } {
  return {
    queueMs: readTimeoutEnv('PIPELINE_QUEUE_TIMEOUT_MS', QUEUE_TIMEOUT_MS_DEFAULT),
    heartbeatMs: readTimeoutEnv('PIPELINE_HEARTBEAT_TIMEOUT_MS', HEARTBEAT_TIMEOUT_MS_DEFAULT),
  };
}

function neverClaimedThresholdMs(): number {
  return readTimeoutEnv('PIPELINE_NEVER_CLAIMED_MS', NEVER_CLAIMED_MS_DEFAULT);
}

export interface ZombieSweepResult {
  queueTimedOut: number;
  heartbeatTimedOut: number;
  // chat/schedule/agent sessions created `running` that never got a working
  // client (claudeSessionId still NULL) — see Pass 3 in sweepZombieSessions.
  noClientAcked: number;
}

export interface OrphanReconcileResult {
  reconciled: number;
}

export interface SweepResult {
  durationMs: number;
  zombieSessions: ZombieSweepResult;
  orphanedJobs: OrphanReconcileResult;
  neverClaimedDispatches: OrphanReconcileResult;
  backstopProjects: number;
  queueSnapshots: number;
}

export async function runPipelineSweep(now: Date = new Date()): Promise<SweepResult> {
  const t0 = Date.now();
  const zombieSessions = await sweepZombieSessions(now);
  // ISS-280 — run reconcile AFTER the zombie pass so a session this very tick
  // flipped to `failed` (heartbeat_timeout) immediately propagates to its
  // still-`dispatched`/`running` job, freeing the runner slot in one tick.
  const orphanedJobs = await reconcileOrphanedJobs(now);
  // ISS-378 — reap `dispatched` jobs no runner ever claimed (zero job_events).
  // reconcileOrphanedJobs above is session-driven and cannot see these (its
  // candidate JOINs agent_sessions and requires a terminal session); without
  // this pass they sit until runStaleSweep's 60-min backstop — long enough to
  // hold the cap=1 slot and block the next stage for hours.
  const neverClaimedDispatches = await reconcileNeverClaimedDispatches(now);
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
    zombieSessions,
    orphanedJobs,
    neverClaimedDispatches,
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

interface SweepScope {
  projectId?: string;
}

/**
 * Fail pipeline sessions abandoned by their worker.
 *
 *  - `queue_timeout`: session sat at `queued` past QUEUE_TIMEOUT_MS — no
 *    worker ever claimed it.
 *  - `heartbeat_timeout`: worker claimed (status='running') but stopped
 *    pinging past HEARTBEAT_TIMEOUT_MS.
 *
 * Scoped to pipeline/pm sessions; interactive chat sessions are out of
 * scope (their idle behaviour is by design). Optional `projectId` scope
 * lets the manual /sweep-zombies endpoint contain blast radius to one
 * project rather than flushing the whole instance.
 */
export async function sweepZombieSessions(
  now: Date,
  scope: SweepScope = {},
): Promise<ZombieSweepResult> {
  const { queueMs, heartbeatMs } = getZombieThresholds();
  const queueCutoff = new Date(now.getTime() - queueMs);
  const heartbeatCutoff = new Date(now.getTime() - heartbeatMs);
  const projectFilter = scope.projectId ? eq(agentSessions.projectId, scope.projectId) : undefined;

  // Pass 1: queued past timeout. CAS via WHERE status='queued' so a worker
  // that claims concurrently isn't stomped. dispatchedAt falls back to
  // createdAt for rows that pre-date the migration.
  const queuedFailed = await db
    .update(agentSessions)
    .set({ status: 'failed', failureReason: 'queue_timeout', updatedAt: now })
    .where(
      and(
        eq(agentSessions.status, 'queued'),
        or(
          and(isNotNull(agentSessions.dispatchedAt), lt(agentSessions.dispatchedAt, queueCutoff)),
          and(sql`${agentSessions.dispatchedAt} IS NULL`, lt(agentSessions.createdAt, queueCutoff)),
        ),
        sql`${agentSessions.metadata}->>'type' IN ${PIPELINE_METADATA_TYPES}`,
        ...(projectFilter ? [projectFilter] : []),
      ),
    )
    .returning({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      deviceId: agentSessions.deviceId,
    });

  for (const z of queuedFailed) {
    broadcastZombieTransition(z.id, z.projectId, z.deviceId, 'queue_timeout');
  }

  // Pass 2: running with stale heartbeat. Falls back through startedAt →
  // updatedAt → createdAt so a rolling deploy with workers still running
  // older code (no heartbeat columns set) doesn't over-sweep — `updatedAt`
  // bumps on every legacy worker write so a >3min-busy job stays alive.
  const heartbeatFailed = await db
    .update(agentSessions)
    .set({ status: 'failed', failureReason: 'heartbeat_timeout', updatedAt: now })
    .where(
      and(
        eq(agentSessions.status, 'running'),
        or(
          and(
            isNotNull(agentSessions.lastHeartbeatAt),
            lt(agentSessions.lastHeartbeatAt, heartbeatCutoff),
          ),
          and(
            sql`${agentSessions.lastHeartbeatAt} IS NULL`,
            isNotNull(agentSessions.startedAt),
            lt(agentSessions.startedAt, heartbeatCutoff),
            lt(agentSessions.updatedAt, heartbeatCutoff),
          ),
          and(
            sql`${agentSessions.lastHeartbeatAt} IS NULL`,
            sql`${agentSessions.startedAt} IS NULL`,
            lt(agentSessions.updatedAt, heartbeatCutoff),
            lt(agentSessions.createdAt, heartbeatCutoff),
          ),
        ),
        sql`${agentSessions.metadata}->>'type' IN ${PIPELINE_METADATA_TYPES}`,
        ...(projectFilter ? [projectFilter] : []),
      ),
    )
    .returning({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      deviceId: agentSessions.deviceId,
    });

  for (const z of heartbeatFailed) {
    broadcastZombieTransition(z.id, z.projectId, z.deviceId, 'heartbeat_timeout');
  }

  // Pass 3: a chat/schedule/agent session (exempt from passes 1-2, which only
  // reap pipeline/pm) created `running` that NEVER got a working client —
  // claudeSessionId is still NULL and the heartbeat never advanced past
  // creation. This is the dominant silent-hang (ISS-420: no online device, a
  // CLI runner that ignored agent:start, etc.) that was never reaped. Safe:
  // an idle chat between turns is `completed` (not running), and a real turn
  // sets claudeSessionId within seconds of spawn — so neither is touched.
  // COALESCE so a NULL/absent metadata.type (plain chat, schedule.run) counts
  // as "not pipeline/pm" and is reaped.
  const noClientFailed = await db
    .update(agentSessions)
    .set({ status: 'failed', failureReason: 'no_client_ack', updatedAt: now })
    .where(
      and(
        eq(agentSessions.status, 'running'),
        sql`${agentSessions.claudeSessionId} IS NULL`,
        sql`COALESCE(${agentSessions.metadata}->>'type','') NOT IN ${PIPELINE_METADATA_TYPES}`,
        or(
          and(
            isNotNull(agentSessions.lastHeartbeatAt),
            lt(agentSessions.lastHeartbeatAt, heartbeatCutoff),
          ),
          and(
            sql`${agentSessions.lastHeartbeatAt} IS NULL`,
            lt(agentSessions.createdAt, heartbeatCutoff),
          ),
        ),
        ...(projectFilter ? [projectFilter] : []),
      ),
    )
    .returning({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      deviceId: agentSessions.deviceId,
    });

  for (const z of noClientFailed) {
    broadcastZombieTransition(z.id, z.projectId, z.deviceId, 'no_client_ack');
  }

  const queueTimedOut = queuedFailed.length;
  const heartbeatTimedOut = heartbeatFailed.length;
  const noClientAcked = noClientFailed.length;

  if (queueTimedOut > 0 || heartbeatTimedOut > 0 || noClientAcked > 0) {
    logger.info(
      { queueTimedOut, heartbeatTimedOut, noClientAcked, queueMs, heartbeatMs },
      'pipeline-sweeper: zombie sessions failed',
    );
  }

  return { queueTimedOut, heartbeatTimedOut, noClientAcked };
}

/**
 * ISS-280 — reverse session→job reconciliation (the missing FAST propagation).
 *
 * `sweepZombieSessions` flips an abandoned `agent_session` to `failed`
 * (`heartbeat_timeout`, ~3min) but never touches the linked `jobs` row. So a
 * runner/agent that dies silently — without calling `POST /jobs/:id/complete`
 * — leaves the job stuck in `dispatched`/`running` forever: it keeps counting
 * toward the cap=1 runner gate (`dispatch-gates` runner_load CTE, parent run
 * still `running`) and wedges the whole project queue (ISS-268: a `fix` job
 * sat `dispatched` ~2h40m after its session went `failed`). The job-level
 * `runStaleSweep` only reaps after a 60-min threshold, so it is too slow.
 *
 * This pass closes the gap: when a linked session is terminal but its job is
 * still active, CAS-flip the job to `failed` and route it through the SAME
 * `finalizeFailedJob` path as `/complete` + `/fail` — so it gets verify-first
 * auto-retry (or park-to-`waiting` + run reap when the budget is exhausted),
 * the agent_session sync, the `job.failed` broadcast, and a `dispatchTickForProject`
 * that refills the freed slot.
 *
 * The `result`-event guard keeps lockstep with `runStaleSweep` (ISS-258): a
 * job that emitted a `result` event reported completion and is a
 * finalize-drop, NOT a silent death — reaping it as `failed` would be a false
 * positive (a separate finalize-as-done recovery is future work).
 *
 * Best-effort: each row is wrapped in try/catch so one failure never aborts
 * the pass; a CAS-loser (a late `/complete` won the race) is skipped.
 */
export async function reconcileOrphanedJobs(
  _now: Date = new Date(),
  scope: SweepScope = {},
): Promise<OrphanReconcileResult> {
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  // Candidate selection is runner-heartbeat-independent — it keys off the
  // SESSION's terminal status (driven by per-job event heartbeats), so it
  // fires even while the RUNNER stays online (ISS-268 had `inFlight=1` on a
  // live runner). Fetch ids only; the CAS UPDATE below returns the typed row.
  const candidates = await db.execute<{ id: string }>(sql`
    SELECT j.id
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

  let reconciled = 0;
  for (const row of candidates) {
    try {
      // CAS on status so a concurrent late `/complete` / `/fail` wins instead
      // of being double-finalized. RETURNING gives the typed JobRow that
      // finalizeFailedJob expects (camelCase, with failureKind/reason set).
      const [updated] = await db
        .update(jobs)
        .set({
          status: 'failed',
          error: 'session_lost',
          finishedAt: new Date(),
          failureKind: 'transient',
          failureReason:
            'agent session terminated without job completion (silent runner/agent death)',
          classifierVersion: 1,
        })
        .where(and(eq(jobs.id, row.id), inArray(jobs.status, ['dispatched', 'running'])))
        .returning();
      if (!updated) continue; // lost the CAS race — a lifecycle call finalized it
      reconciled++;
      await finalizeFailedJob(updated, { error: 'session_lost' });
    } catch (err) {
      logger.error(
        { err, jobId: row.id },
        'pipeline-sweeper: orphan job reconcile failed (row skipped)',
      );
    }
  }

  if (reconciled > 0) {
    logger.info({ reconciled }, 'pipeline-sweeper: orphaned jobs reconciled to failed');
  }

  return { reconciled };
}

/**
 * ISS-378 — reap `dispatched` jobs that NO runner ever claimed.
 *
 * The wedge: an auto-retry job was dispatched but its assigned runner never
 * acked it (no `job_events` at all, not even `started`, so `started_at` stays
 * NULL). `reconcileOrphanedJobs` can't see it — that pass JOINs
 * `agent_sessions` and only fires when the SESSION is terminal, but an
 * auto-retry inherits the prior attempt's `agent_session_id` (retry.ts), which
 * may be `completed`/`running`, so the JOIN never matches. The only other net
 * was `runStaleSweep` at 60min. In between, the unclaimed `dispatched` row kept
 * counting toward the cap=1 runner gate (parent run still `running`) AND held
 * the prior stage non-terminal under strict-sequential — wedging the queue for
 * ~4h (ISS-378, web-v2 agents console).
 *
 * Candidate = `dispatched` + `dispatched_at` older than the grace window +
 * ZERO job_events (an event of any kind means the runner DID claim it; that
 * case is the 60-min quiet backstop's job, not this one). The `result`-event
 * exclusion the sibling passes carry is implied by "zero events".
 *
 * Reaping routes through the SAME `finalizeFailedJob` path, so the verify-first
 * retry resolves a moot orphan whose issue already advanced
 * (`completed_via_recovery`) instead of spawning a duplicate, retries onto
 * another runner when the work is genuinely still pending, or parks the issue
 * at `waiting` when the budget is exhausted. CAS on `status='dispatched'` so a runner that claims
 * (emits `started`) in the same instant wins the race.
 */
export async function reconcileNeverClaimedDispatches(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<OrphanReconcileResult> {
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  // postgres-js rejects raw Date params (Buffer.byteLength expects
  // string/Buffer/ArrayBuffer); serialise to ISO before binding.
  const cutoffIso = new Date(now.getTime() - neverClaimedThresholdMs()).toISOString();
  const candidates = await db.execute<{ id: string }>(sql`
    SELECT j.id
    FROM jobs j
    WHERE j.status = 'dispatched'
      AND j.dispatched_at IS NOT NULL
      AND j.dispatched_at < ${cutoffIso}
      AND NOT EXISTS (
        SELECT 1 FROM job_events e WHERE e.job_id = j.id
      )
      ${projectClause}
  `);

  let reconciled = 0;
  for (const row of candidates) {
    try {
      const [updated] = await db
        .update(jobs)
        .set({
          status: 'failed',
          error: 'dispatch_unclaimed',
          finishedAt: new Date(),
          failureKind: 'transient',
          failureReason:
            'dispatch never claimed by a runner (no started event within grace window)',
          classifierVersion: 1,
        })
        .where(and(eq(jobs.id, row.id), eq(jobs.status, 'dispatched')))
        .returning();
      if (!updated) continue; // lost the CAS race — the runner just claimed it
      reconciled++;
      await finalizeFailedJob(updated, { error: 'dispatch_unclaimed' });
    } catch (err) {
      logger.error(
        { err, jobId: row.id },
        'pipeline-sweeper: never-claimed dispatch reconcile failed (row skipped)',
      );
    }
  }

  if (reconciled > 0) {
    logger.info({ reconciled }, 'pipeline-sweeper: never-claimed dispatches reaped to failed');
  }

  return { reconciled };
}

function broadcastZombieTransition(
  sessionId: string,
  projectId: string,
  deviceId: string | null,
  reason: 'queue_timeout' | 'heartbeat_timeout' | 'no_client_ack',
): void {
  broadcastSessionEvent(sessionId, projectId, deviceId, 'agent-session.status', {
    status: 'failed',
    failureReason: reason,
  });
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
