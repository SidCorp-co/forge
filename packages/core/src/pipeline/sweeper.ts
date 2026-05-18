/**
 * Pipeline self-healing sweeper — zombie session cleanup ONLY.
 *
 * Previously this file also handled multi-tier "stuck issue" recovery
 * (re-enqueue + recoveryAttempts budget + pipeline_failed escalation).
 * The failure model now blocks issues via setManualHoldBlock at the
 * source (worker /fail, watchdog kills, adapter errors); operator
 * action is the only thing that resumes a blocked pipeline. The sweeper
 * no longer auto-recovers.
 *
 * What remains: a 60s tick that fails abandoned agent_sessions
 * (queue_timeout / heartbeat_timeout). These are observability rows —
 * once flipped to `failed`, the WS broadcast clears their "running"
 * spinner in the UI without operator intervention. No job/issue state
 * is mutated here.
 */

import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { broadcastSessionEvent } from '../jobs/agent-session-link.js';
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
}

export async function runPipelineSweep(now: Date = new Date()): Promise<SweepResult> {
  const t0 = Date.now();
  recordPipelineSweeperTick(t0);
  const zombieSessions = await sweepZombieSessions(now);
  return { durationMs: Date.now() - t0, zombieSessions };
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
