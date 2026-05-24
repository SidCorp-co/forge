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
import { boss } from '../queue/boss.js';

export const PIPELINE_SWEEPER_QUEUE = 'pipeline-sweeper';

// Zombie thresholds clamp at MIN_TIMEOUT_MS so a low env override can't
// slaughter healthy sessions (a 10s heartbeat threshold would).
const QUEUE_TIMEOUT_MS_DEFAULT = 5 * 60_000;
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

export interface SweepResult {
  durationMs: number;
  zombieSessions: ZombieSweepResult;
  backstopProjects: number;
}

export async function runPipelineSweep(now: Date = new Date()): Promise<SweepResult> {
  const t0 = Date.now();
  const zombieSessions = await sweepZombieSessions(now);
  const backstopProjects = await runDispatcherBackstop();
  // Record the heartbeat ONLY after every pass succeeded. Recording at the
  // top would leave `pgboss-health` blind to a silent backstop failure
  // (lastTickAt fresh, dispatcher.tick_missing never fires). Letting either
  // pass throw lets pg-boss retry and pgboss-health alert.
  recordPipelineSweeperTick(t0);
  return { durationMs: Date.now() - t0, zombieSessions, backstopProjects };
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
