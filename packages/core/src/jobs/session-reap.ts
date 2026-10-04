import { and, eq, inArray, isNotNull, lt, or, type SQL, sql } from 'drizzle-orm';
import { SWEEP_SESSION_COLUMNS, transitionSessions } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { logger } from '../observability/logger.js';
import { emitPipelineWedge } from '../pipeline/index.js';
import type { LoopScope } from './loop-monitor.js';
import { getLoopThresholds } from './loop-monitor-thresholds.js';
import { jobsPorts } from './ports.js';
import { broadcastZombieTransition, lookupIssueForRun, reapQueueHop } from './queue-hop.js';
import { CLIENT_SESSION_KINDS, heartbeatReapedSql } from './session-kinds.js';

export interface ZombieSessionReapResult {
  queueTimedOut: number;
  /** ISS-1101 — claimed, reported, then silent with no turn ever reported. */
  turnNeverReported: number;
  heartbeatTimedOut: number;
  noClientAcked: number;
}

/**
 * Hops 2–3a/b (session axis) — claim + heartbeat. The three zombie passes
 * moved verbatim from pipeline/sweeper.ts `sweepZombieSessions` (ISS-232 /
 * ISS-280 / ISS-420 semantics preserved), now emitting a wedge per reap.
 * Also serves the manual `/agent-sessions/sweep-zombies` endpoint via `scope`.
 */
export async function reapZombieSessions(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<ZombieSessionReapResult> {
  const { queueMs, heartbeatMs, ackFastMs } = getLoopThresholds();
  const queueCutoff = new Date(now.getTime() - queueMs);
  const heartbeatCutoff = new Date(now.getTime() - heartbeatMs);
  const projectFilter = scope.projectId ? eq(agentSessions.projectId, scope.projectId) : undefined;

  const { queueTimedOut, turnNeverReported } = await reapQueueHop({
    now,
    queueCutoff,
    quietCutoff: heartbeatCutoff,
    projectFilter,
  });

  const heartbeatTimedOut = await reapHeartbeatMisses(now, heartbeatCutoff, projectFilter);
  const noClientAcked = await reapNoClientSessions(
    now,
    heartbeatCutoff,
    new Date(now.getTime() - ackFastMs).toISOString(),
    projectFilter,
  );

  const result: ZombieSessionReapResult = {
    queueTimedOut,
    turnNeverReported,
    heartbeatTimedOut,
    noClientAcked,
  };

  if (Object.values(result).some((n) => n > 0)) {
    logger.info({ ...result, queueMs, heartbeatMs }, 'loop-monitor: zombie sessions failed');
  }

  return result;
}

/** Hop 3a — a running session whose heartbeat (or, before its first beat, its start) went stale. */
async function reapHeartbeatMisses(
  now: Date,
  heartbeatCutoff: Date,
  projectFilter: SQL | undefined,
): Promise<number> {
  const heartbeatFailed = (
    await transitionSessions(db, {
      returning: SWEEP_SESSION_COLUMNS,
      to: 'failed',
      set: { failureReason: 'heartbeat_timeout', updatedAt: now },
      where: and(
        eq(agentSessions.status, 'running'),
        sql`${agentSessions.runtimeState} IS DISTINCT FROM 'awaiting_input'`,
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
        heartbeatReapedSql(sql`${agentSessions}`),
        ...(projectFilter ? [projectFilter] : []),
      ),
      reason: 'heartbeat_timeout',
      actor: { type: 'sweeper' },
      source: 'loop-monitor',
    })
  ).rows;

  for (const z of heartbeatFailed) {
    broadcastZombieTransition(z.id, z.projectId, z.deviceId, 'heartbeat_timeout');
    await emitPipelineWedge({
      projectId: z.projectId,
      issueId: await lookupIssueForRun(z.pipelineRunId),
      hop: 'heartbeat',
      entity: 'session',
      entityId: z.id,
      reason: 'worker claimed the session but its heartbeat went stale',
      action:
        'Check the device: is the forge-runner daemon alive, did the Claude CLI process die? The job axis recovers via session-lost reap + retry.',
    });
  }
  return heartbeatFailed.length;
}

// No-client hop (ISS-420): a chat/schedule/agent session created `running`
// that never got a working client — claudeSessionId still NULL and the
// heartbeat never advanced past creation. The arm is `kind IN
// CLIENT_SESSION_KINDS`, so a species a pipeline step drives is outside it.
async function reapNoClientSessions(
  now: Date,
  heartbeatCutoff: Date,
  ackFastCutoffIso: string,
  projectFilter: SQL | undefined,
): Promise<number> {
  const noClientFailed = (
    await transitionSessions(db, {
      returning: SWEEP_SESSION_COLUMNS,
      to: 'failed',
      set: { failureReason: 'no_client_ack', updatedAt: now },
      where: and(
        eq(agentSessions.status, 'running'),
        sql`${agentSessions.claudeSessionId} IS NULL`,
        inArray(agentSessions.kind, CLIENT_SESSION_KINDS),
        or(
          and(
            sql`${agentSessions.metadata}->>'acked' = 'true'`,
            sql`COALESCE(${agentSessions.dispatchedAt}, ${agentSessions.createdAt}) < ${ackFastCutoffIso}`,
          ),
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
      reason: 'no_client_ack',
      actor: { type: 'sweeper' },
      source: 'loop-monitor',
    })
  ).rows;

  for (const z of noClientFailed) {
    broadcastZombieTransition(z.id, z.projectId, z.deviceId, 'no_client_ack');
    // ISS-584 (B): a schedule run that never attached ran zero side effects, so
    // it is safe to re-dispatch onto another runner (async failover, mirrors the
    // job reaper→retry model). Plain chat returns `not-schedule` and is left for
    // the user to retry. Best-effort: a throw here must not abort the sweep.
    let failover: { ok: boolean; sessionId?: string; deviceId?: string } | null = null;
    try {
      failover = await jobsPorts().redispatchScheduleSessionOnFailover(z.id);
      if (failover.ok) {
        logger.info(
          {
            failedSessionId: z.id,
            retrySessionId: failover.sessionId,
            deviceId: failover.deviceId,
          },
          'loop-monitor: schedule no_client_ack re-dispatched to another runner',
        );
      }
    } catch (err) {
      logger.error({ err, sessionId: z.id }, 'loop-monitor: schedule failover threw (skipped)');
    }
    // A successful failover already re-queued the work, so the wedge would be
    // noise; only flag the genuine dead-ends (no device left / chain exhausted /
    // plain chat) that still need a human or device.
    if (!failover?.ok) {
      await emitPipelineWedge({
        projectId: z.projectId,
        issueId: await lookupIssueForRun(z.pipelineRunId),
        hop: 'claim',
        entity: 'session',
        entityId: z.id,
        reason: 'session was created running but no client ever attached (no claudeSessionId)',
        action:
          'Check that the target device is online and accepting agent:start. Re-run the schedule/chat turn once a device is available.',
      });
    }
  }
  return noClientFailed.length;
}
