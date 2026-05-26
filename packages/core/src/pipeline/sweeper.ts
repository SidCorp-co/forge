/**
 * Pipeline self-healing sweeper — zombie session cleanup + dispatcher backstop.
 *
 * Previously this file also handled multi-tier "stuck issue" recovery
 * (re-enqueue + recoveryAttempts budget + pipeline_failed escalation).
 * The failure model now blocks issues via setManualHoldBlock at the
 * source (worker /fail, watchdog kills, adapter errors); operator
 * action is the only thing that resumes a blocked pipeline.
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

import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, jobs } from '../db/schema.js';
import { broadcastSessionEvent } from '../jobs/agent-session-link.js';
import { dispatchTickForProject } from '../jobs/dispatch-tick.js';
import { recordPipelineSweeperTick } from '../jobs/pgboss-health.js';
import { logger } from '../logger.js';
import { recordHoldAutoClear } from '../observability/hold-metrics.js';
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

export interface ZombieSweepResult {
  queueTimedOut: number;
  heartbeatTimedOut: number;
}

export interface ExpiredHoldsSweepResult {
  cleared: number;
}

export interface SweepResult {
  durationMs: number;
  zombieSessions: ZombieSweepResult;
  expiredHolds: ExpiredHoldsSweepResult;
  backstopProjects: number;
}

export async function runPipelineSweep(now: Date = new Date()): Promise<SweepResult> {
  const t0 = Date.now();
  const zombieSessions = await sweepZombieSessions(now);
  const expiredHolds = await sweepExpiredHolds(now);
  const backstopProjects = await runDispatcherBackstop();
  // Record the heartbeat ONLY after every pass succeeded. Recording at the
  // top would leave `pgboss-health` blind to a silent backstop failure
  // (lastTickAt fresh, dispatcher.tick_missing never fires). Letting either
  // pass throw lets pg-boss retry and pgboss-health alert.
  recordPipelineSweeperTick(t0);
  return { durationMs: Date.now() - t0, zombieSessions, expiredHolds, backstopProjects };
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
          and(
            sql`${agentSessions.dispatchedAt} IS NULL`,
            lt(agentSessions.createdAt, queueCutoff),
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

  const queueTimedOut = queuedFailed.length;
  const heartbeatTimedOut = heartbeatFailed.length;

  if (queueTimedOut > 0 || heartbeatTimedOut > 0) {
    logger.info(
      { queueTimedOut, heartbeatTimedOut, queueMs, heartbeatMs },
      'pipeline-sweeper: zombie sessions failed',
    );
  }

  return { queueTimedOut, heartbeatTimedOut };
}

function broadcastZombieTransition(
  sessionId: string,
  projectId: string,
  deviceId: string | null,
  reason: 'queue_timeout' | 'heartbeat_timeout',
): void {
  broadcastSessionEvent(sessionId, projectId, deviceId, 'agent-session.status', {
    status: 'failed',
    failureReason: reason,
  });
}

/**
 * ISS-198 — auto-clear expired manualHold rows.
 *
 * A row is cleared when:
 *   - `manual_hold = true`,
 *   - `manual_hold_until` is non-NULL and in the past,
 *   - no `failed` job for the same issue finished in the last 5 minutes
 *     (anti-ping-pong: don't clear a hold whose latest cause still smells
 *     fresh).
 *
 * Re-enqueueing is implicit — the dispatcher's L1 gate stops excluding the
 * issue the moment `manual_hold` flips false, so the next picker tick will
 * pick up any pending job on its own. Do not add a separate enqueue here.
 */
export async function sweepExpiredHolds(
  now: Date,
  scope: SweepScope = {},
): Promise<ExpiredHoldsSweepResult> {
  const projectClause = scope.projectId
    ? sql`AND issues.project_id = ${scope.projectId}`
    : sql``;
  // postgres-js driver rejects raw Date params (Buffer.byteLength expects
  // string/Buffer/ArrayBuffer). Serialise to ISO before binding.
  const nowIso = now.toISOString();
  const rows = await db.execute<{
    id: string;
    project_id: string;
    held_at: Date | string | null;
    failure_kind: string | null;
  }>(sql`
    WITH cleared AS (
      UPDATE issues
      SET manual_hold = false,
          manual_hold_until = NULL,
          updated_at = ${nowIso}
      WHERE manual_hold = true
        AND manual_hold_until IS NOT NULL
        AND manual_hold_until < ${nowIso}
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.issue_id = issues.id
            AND j.status = 'failed'
            AND j.finished_at > now() - interval '5 minutes'
        )
        ${projectClause}
      RETURNING id, project_id, updated_at, failure_context
    )
    SELECT id, project_id,
           updated_at AS held_at,
           (failure_context->'classification'->>'kind') AS failure_kind
    FROM cleared
  `);

  for (const row of rows) {
    const kind = (row.failure_kind ?? 'unknown_no_context') as
      | 'transient_network'
      | 'permanent_invalid'
      | 'unknown'
      | 'unknown_no_context';
    roomManager.publish(projectRoom(row.project_id), {
      event: 'issue.holdCleared',
      data: { issueId: row.id, reason: 'auto_clear' },
    });
    if (isSentryEnabled()) {
      Sentry.addBreadcrumb({
        category: 'pipeline.reconciler.hold_auto_cleared',
        level: 'info',
        message: `auto-cleared manualHold for issue ${row.id}`,
        data: {
          issueId: row.id,
          holdReason: row.failure_kind,
          // holdDuration would require capturing held_since; we don't track
          // that today, so emit null and document the field in the contract.
          holdDuration: null,
        },
      });
    }
    recordHoldAutoClear({ kind });
  }

  if (rows.length > 0) {
    logger.info({ cleared: rows.length }, 'pipeline-sweeper: expired holds cleared');
  }

  return { cleared: rows.length };
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
