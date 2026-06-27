/**
 * ISS-449 (ISS-442 C3 / invariant I3) — the closed job loop.
 *
 * Models the job lifecycle as four hops — dispatch → ack → heartbeat →
 * result — each with ONE timeout and exactly ONE miss-handler. This module is
 * the PRIMARY reaper for every non-progressing kernel state; the four legacy
 * sweepers (`sweepZombieSessions`, `reconcileOrphanedJobs`,
 * `reconcileNeverClaimedDispatches` in pipeline/sweeper.ts and `runStaleSweep`
 * in jobs/stale-detector.ts) are demoted to alarm-only: they keep their
 * detection SELECTs but perform no terminal writes — a row they still match
 * after this loop ran is a loop MISS, logged as `loop-miss` (coverage proof
 * during the cutover; deletion happens at the ISS-442 parent integration).
 *
 * Hops and their miss-handlers (all terminal writes via
 * `applyKernelTransition`, all job reaps routed through the SAME
 * `finalizeFailedJob` tail as a runner-reported failure — verify-first retry
 * or park-at-`waiting`):
 *
 *   1. dispatch→ack — the runner explicitly acks a claim (`POST
 *      /jobs/:id/ack`, ISS-449; first job_event doubles as a fallback ack).
 *      A `dispatched` job with no ack and zero events past the grace window
 *      means no runner ever claimed it → fail `dispatch_unclaimed`
 *      (kind `infra`, fast failover). Replaces
 *      `reconcileNeverClaimedDispatches` (ISS-378).
 *   2. ack→heartbeat (claim) — a pipeline/pm session sitting `queued` past
 *      the queue timeout was never picked up by a worker → fail the session
 *      `queue_timeout`. Replaces zombie pass 1.
 *   3. heartbeat — (a) a `running` pipeline/pm session whose heartbeat went
 *      stale → fail `heartbeat_timeout`; (b) a chat/schedule session that
 *      never got a working client (`claudeSessionId` NULL) → fail
 *      `no_client_ack` (ISS-420); (c) a job whose linked session is terminal
 *      with no `result` event → fail `session_lost` (kind `infra`). Replaces
 *      zombie passes 2–3 + `reconcileOrphanedJobs` (ISS-280).
 *   4. result — a claimed job that emitted no event for RESULT_QUIET_MINUTES
 *      (and never a `result`) is a wedged worker → fail `stale`
 *      (kind `timeout`). Replaces `runStaleSweep` (ISS-258), now evaluated on
 *      the 1-minute loop tick instead of the old 5-minute schedule.
 *
 * Every miss-handler emits a `pipeline_wedge` event (ISS-452 C6 / I7) carrying
 * WHERE (the hop) + WHY (the reason) + WHAT a human should do, so
 * `interventions/issue` is measurable.
 *
 * Constraint: strict-sequential dispatch is untouched — the loop only REAPS
 * non-progressing state; it never relaxes terminal-before-next gating.
 *
 * Scheduling: `runLoopMonitor` runs as the FIRST pass of the per-minute
 * pipeline-sweeper tick (pipeline/sweeper.ts `runPipelineSweep`), so the
 * demoted alarm passes in the same tick only see rows the loop failed to
 * handle.
 */

import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, jobs, pipelineRuns } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { emitPipelineWedge } from '../pipeline/wedge.js';
import { broadcastSessionEvent } from './agent-session-link.js';
import { finalizeFailedJob } from './finalize-failure.js';

// Lazily loaded (ISS-584 B). schedules/dispatch.js pulls a heavy prompt-builder
// chain (and through it the env-validating embeddings module); importing it
// statically here would drag that into every consumer of the loop-monitor (and
// break hermetic unit suites that don't stub env). The sweeper only needs it at
// runtime, so resolve it on first use and cache.
type RedispatchFn = (
  sessionId: string,
) => Promise<{ ok: boolean; status: string; sessionId?: string; deviceId?: string }>;
let _redispatchScheduleFn: RedispatchFn | null = null;
async function getRedispatchScheduleFn(): Promise<RedispatchFn> {
  if (!_redispatchScheduleFn) {
    const mod = await import('../schedules/dispatch.js');
    _redispatchScheduleFn = mod.redispatchScheduleSessionOnFailover;
  }
  return _redispatchScheduleFn;
}

// Hop thresholds. Clamped at MIN_TIMEOUT_MS so a low env override can't
// slaughter healthy rows. Values + env names carried over from the demoted
// sweepers so existing deploy configs keep working:
//   - queue (claim hop):      PIPELINE_QUEUE_TIMEOUT_MS      (ISS-232: 2 min)
//   - heartbeat hop:          PIPELINE_HEARTBEAT_TIMEOUT_MS  (3 min)
//   - ack hop:                PIPELINE_NEVER_CLAIMED_MS      (ISS-378: 3 min)
const QUEUE_TIMEOUT_MS_DEFAULT = 120_000;
const HEARTBEAT_TIMEOUT_MS_DEFAULT = 3 * 60_000;
const ACK_TIMEOUT_MS_DEFAULT = 3 * 60_000;
const MIN_TIMEOUT_MS = 30_000;
// ISS-584 (C): fast-fail grace for a chat/schedule session that the runner ACKed
// (positive "I got it") but that never produced a claudeSessionId — claude died
// on startup. Short because the ack already proved a live runner; only a dead
// claude leaves claudeSessionId NULL past this window. Not-acked sessions keep
// the conservative heartbeat timeout (rollout-safe for runners without ack).
const ACK_FAST_MS_DEFAULT = 90_000;

/** Result-hop quiet threshold (was runStaleSweep's STALE_THRESHOLD; ISS-258
 *  bumped 5→60 min because legit forge-release/forge-code merges run >5min
 *  between event emissions). Exported so the demoted stale-detector alarm can
 *  derive its margin from the same number. */
export const RESULT_QUIET_MINUTES = 60;

const PIPELINE_METADATA_TYPES = sql`('pipeline','pm')`;

function readTimeoutEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_TIMEOUT_MS ? n : fallback;
}

export function getLoopThresholds(): {
  queueMs: number;
  heartbeatMs: number;
  ackMs: number;
  ackFastMs: number;
} {
  return {
    queueMs: readTimeoutEnv('PIPELINE_QUEUE_TIMEOUT_MS', QUEUE_TIMEOUT_MS_DEFAULT),
    heartbeatMs: readTimeoutEnv('PIPELINE_HEARTBEAT_TIMEOUT_MS', HEARTBEAT_TIMEOUT_MS_DEFAULT),
    ackMs: readTimeoutEnv('PIPELINE_NEVER_CLAIMED_MS', ACK_TIMEOUT_MS_DEFAULT),
    ackFastMs: readTimeoutEnv('PIPELINE_ACK_FAST_MS', ACK_FAST_MS_DEFAULT),
  };
}

export interface LoopScope {
  projectId?: string;
}

export interface ZombieSessionReapResult {
  queueTimedOut: number;
  heartbeatTimedOut: number;
  noClientAcked: number;
}

export interface LoopMonitorResult {
  /** dispatch→ack misses reaped (`dispatch_unclaimed`). */
  ackMisses: number;
  /** Session-level claim/heartbeat misses reaped. */
  sessions: ZombieSessionReapResult;
  /** Jobs failed because their linked session is terminal (`session_lost`). */
  sessionLostJobs: number;
  /** result-hop misses reaped (`stale`, no event for RESULT_QUIET_MINUTES). */
  resultMisses: number;
}

/** Resolve the linked issue for a session's wedge event via its pipeline_run
 *  (sessions carry no issue_id of their own). Best-effort. */
async function lookupIssueForRun(pipelineRunId: string | null): Promise<string | null> {
  if (!pipelineRunId) return null;
  try {
    const [row] = await db
      .select({ issueId: pipelineRuns.issueId })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, pipelineRunId))
      .limit(1);
    return row?.issueId ?? null;
  } catch {
    return null;
  }
}

/**
 * Hop 1 — dispatch→ack. A `dispatched` job that was never acked and emitted
 * zero events past the grace window: no runner claimed it. CAS on
 * `status='dispatched'` so a runner that acks in the same instant wins.
 */
export async function reapAckMisses(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<number> {
  const { ackMs } = getLoopThresholds();
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  // postgres-js rejects raw Date params; serialise to ISO before binding.
  const cutoffIso = new Date(now.getTime() - ackMs).toISOString();
  const candidates = await db.execute<{ id: string }>(sql`
    SELECT j.id
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

  let reaped = 0;
  for (const row of candidates) {
    try {
      const [updated] = await applyKernelTransition(db, {
        entity: 'job',
        to: 'failed',
        set: {
          error: 'dispatch_unclaimed',
          finishedAt: new Date(),
          failureKind: 'infra',
          failureReason:
            'dispatch never claimed by a runner (no ack / no started event within grace window)',
          classifierVersion: 3,
        },
        where: and(eq(jobs.id, row.id), eq(jobs.status, 'dispatched')),
        fromStatus: 'dispatched',
        reason: 'dispatch_unclaimed',
        actor: { type: 'sweeper' },
        source: 'loop-monitor',
      });
      if (!updated) continue; // lost the CAS race — the runner just claimed it
      reaped++;
      await emitPipelineWedge({
        projectId: updated.projectId,
        issueId: updated.issueId,
        hop: 'ack',
        entity: 'job',
        entityId: updated.id,
        reason: 'runner never acked the dispatch (no ack, zero job events) within the grace window',
        action:
          'Check the assigned device is online and its forge-runner daemon is running. The job was auto-failed and routed to device-rotated retry; if it recurs, rotate or unbind the device.',
      });
      await finalizeFailedJob(updated, { error: 'dispatch_unclaimed' });
    } catch (err) {
      logger.error({ err, jobId: row.id }, 'loop-monitor: ack-miss reap failed (row skipped)');
    }
  }

  if (reaped > 0) {
    logger.info({ reaped }, 'loop-monitor: ack-hop misses reaped to failed');
  }
  return reaped;
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
  const ackFastCutoff = new Date(now.getTime() - ackFastMs);
  const projectFilter = scope.projectId ? eq(agentSessions.projectId, scope.projectId) : undefined;

  // Claim hop: queued past timeout. CAS via WHERE status='queued' so a worker
  // that claims concurrently isn't stomped. dispatchedAt falls back to
  // createdAt for rows that pre-date the migration.
  const queuedFailed = await applyKernelTransition(db, {
    entity: 'session',
    to: 'failed',
    set: { failureReason: 'queue_timeout', updatedAt: now },
    where: and(
      eq(agentSessions.status, 'queued'),
      or(
        and(isNotNull(agentSessions.dispatchedAt), lt(agentSessions.dispatchedAt, queueCutoff)),
        and(sql`${agentSessions.dispatchedAt} IS NULL`, lt(agentSessions.createdAt, queueCutoff)),
      ),
      sql`${agentSessions.metadata}->>'type' IN ${PIPELINE_METADATA_TYPES}`,
      ...(projectFilter ? [projectFilter] : []),
    ),
    fromStatus: 'queued',
    reason: 'queue_timeout',
    actor: { type: 'sweeper' },
    source: 'loop-monitor',
  });

  for (const z of queuedFailed) {
    broadcastZombieTransition(z.id, z.projectId, z.deviceId, 'queue_timeout');
    await emitPipelineWedge({
      projectId: z.projectId,
      issueId: await lookupIssueForRun(z.pipelineRunId),
      hop: 'claim',
      entity: 'session',
      entityId: z.id,
      reason: 'no worker claimed the session within the queue timeout',
      action:
        'Check that an online runner is bound to this project. The session was failed; the job axis recovers via the heartbeat hop + retry.',
    });
  }

  // Heartbeat hop (pipeline/pm): running with stale heartbeat. Falls back
  // through startedAt → updatedAt → createdAt so a rolling deploy with workers
  // still running older code doesn't over-sweep.
  const heartbeatFailed = await applyKernelTransition(db, {
    entity: 'session',
    to: 'failed',
    set: { failureReason: 'heartbeat_timeout', updatedAt: now },
    where: and(
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
    fromStatus: 'running',
    reason: 'heartbeat_timeout',
    actor: { type: 'sweeper' },
    source: 'loop-monitor',
  });

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

  // No-client hop (ISS-420): a chat/schedule/agent session created `running`
  // that never got a working client — claudeSessionId still NULL and the
  // heartbeat never advanced past creation. COALESCE so a NULL/absent
  // metadata.type (plain chat, schedule.run) counts as "not pipeline/pm".
  const noClientFailed = await applyKernelTransition(db, {
    entity: 'session',
    to: 'failed',
    set: { failureReason: 'no_client_ack', updatedAt: now },
    where: and(
      eq(agentSessions.status, 'running'),
      sql`${agentSessions.claudeSessionId} IS NULL`,
      sql`COALESCE(${agentSessions.metadata}->>'type','') NOT IN ${PIPELINE_METADATA_TYPES}`,
      or(
        // ISS-584 (C) fast path: the runner ACKed (a live client received the
        // turn) but claude never emitted a session id within the short grace →
        // claude died on startup. Positive ack evidence, so a SHORT window is
        // safe (no false-positive on runners that don't ack — they fall through
        // to the conservative heartbeat branches below).
        and(
          sql`${agentSessions.metadata}->>'acked' = 'true'`,
          lt(
            sql`COALESCE(${agentSessions.dispatchedAt}, ${agentSessions.createdAt})`,
            ackFastCutoff,
          ),
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
    fromStatus: 'running',
    reason: 'no_client_ack',
    actor: { type: 'sweeper' },
    source: 'loop-monitor',
  });

  for (const z of noClientFailed) {
    broadcastZombieTransition(z.id, z.projectId, z.deviceId, 'no_client_ack');
    // ISS-584 (B): a schedule run that never attached ran zero side effects, so
    // it is safe to re-dispatch onto another runner (async failover, mirrors the
    // job reaper→retry model). Plain chat returns `not-schedule` and is left for
    // the user to retry. Best-effort: a throw here must not abort the sweep.
    let failover: { ok: boolean; sessionId?: string; deviceId?: string } | null = null;
    try {
      const redispatch = await getRedispatchScheduleFn();
      failover = await redispatch(z.id);
      if (failover.ok) {
        logger.info(
          { failedSessionId: z.id, retrySessionId: failover.sessionId, deviceId: failover.deviceId },
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

  const result: ZombieSessionReapResult = {
    queueTimedOut: queuedFailed.length,
    heartbeatTimedOut: heartbeatFailed.length,
    noClientAcked: noClientFailed.length,
  };

  if (result.queueTimedOut > 0 || result.heartbeatTimedOut > 0 || result.noClientAcked > 0) {
    logger.info({ ...result, queueMs, heartbeatMs }, 'loop-monitor: zombie sessions failed');
  }

  return result;
}

/**
 * Hop 3c (job axis) — session-lost propagation. When a linked session is
 * terminal but its job is still active (and never emitted a `result` event),
 * CAS-flip the job to `failed` and route through the shared finalize tail.
 * Moved from pipeline/sweeper.ts `reconcileOrphanedJobs` (ISS-280 semantics
 * preserved, incl. the result-event false-positive guard).
 */
export async function reapSessionLostJobs(
  _now: Date = new Date(),
  scope: LoopScope = {},
): Promise<number> {
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
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

  let reaped = 0;
  for (const row of candidates) {
    try {
      const [updated] = await applyKernelTransition(db, {
        entity: 'job',
        to: 'failed',
        set: {
          error: 'session_lost',
          finishedAt: new Date(),
          failureKind: 'infra',
          failureReason:
            'agent session terminated without job completion (silent runner/agent death)',
          classifierVersion: 3,
        },
        where: and(eq(jobs.id, row.id), inArray(jobs.status, ['dispatched', 'running'])),
        fromStatus: 'active',
        reason: 'session_lost',
        actor: { type: 'sweeper' },
        source: 'loop-monitor',
      });
      if (!updated) continue; // lost the CAS race — a lifecycle call finalized it
      reaped++;
      await emitPipelineWedge({
        projectId: updated.projectId,
        issueId: updated.issueId,
        hop: 'heartbeat',
        entity: 'job',
        entityId: updated.id,
        reason: 'linked agent session terminated without the job reporting completion',
        action:
          'The job was failed and routed to retry. If retries keep landing here, inspect the device runner logs for silent deaths.',
      });
      await finalizeFailedJob(updated, { error: 'session_lost' });
    } catch (err) {
      logger.error({ err, jobId: row.id }, 'loop-monitor: session-lost reap failed (row skipped)');
    }
  }

  if (reaped > 0) {
    logger.info({ reaped }, 'loop-monitor: session-lost jobs reconciled to failed');
  }
  return reaped;
}

/**
 * Hop 4 — result. A claimed job whose latest event (or dispatch, if events
 * are gone quiet entirely) is older than RESULT_QUIET_MINUTES and that never
 * emitted a `result` event: the worker is wedged. Moved from
 * jobs/stale-detector.ts `runStaleSweep` (ISS-258 semantics preserved, incl.
 * the result-event finalize-drop guard), now ticking every minute.
 */
export async function reapResultMisses(
  _now: Date = new Date(),
  scope: LoopScope = {},
): Promise<number> {
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  const candidates = await db.execute<{ id: string }>(sql`
    WITH last_event AS (
      SELECT job_id, MAX(ts) AS max_ts
      FROM job_events
      GROUP BY job_id
    )
    SELECT j.id
    FROM jobs j
    LEFT JOIN last_event le ON le.job_id = j.id
    WHERE j.status IN ('dispatched', 'running')
      AND NOT EXISTS (
        SELECT 1 FROM job_events
        WHERE job_id = j.id AND kind = 'result'
      )
      AND GREATEST(COALESCE(le.max_ts, j.dispatched_at), j.dispatched_at) <
          now() - interval '${sql.raw(String(RESULT_QUIET_MINUTES))} minutes'
      ${projectClause}
  `);

  const STALE_REASON = `runner stale (no progress / no started event for >${RESULT_QUIET_MINUTES}min)`;
  let reaped = 0;
  for (const row of candidates) {
    try {
      const [updated] = await applyKernelTransition(db, {
        entity: 'job',
        to: 'failed',
        set: {
          error: 'stale',
          finishedAt: new Date(),
          failureKind: 'timeout',
          failureReason: STALE_REASON,
          classifierVersion: 3,
        },
        where: and(eq(jobs.id, row.id), inArray(jobs.status, ['dispatched', 'running'])),
        fromStatus: 'active',
        reason: 'stale',
        actor: { type: 'sweeper' },
        source: 'loop-monitor',
      });
      if (!updated) continue;
      reaped++;
      await emitPipelineWedge({
        projectId: updated.projectId,
        issueId: updated.issueId,
        hop: 'result',
        entity: 'job',
        entityId: updated.id,
        reason: STALE_REASON,
        action:
          'The job was failed and routed to a device-rotated retry. Check the original device for a hung Claude CLI / runaway step.',
      });
      await finalizeFailedJob(updated, { error: STALE_REASON });
    } catch (err) {
      logger.error({ err, jobId: row.id }, 'loop-monitor: result-miss reap failed (row skipped)');
    }
  }

  if (reaped > 0) {
    logger.info({ reaped }, 'loop-monitor: result-hop misses reaped to failed');
  }
  return reaped;
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
  const sessionLostJobs = await reapSessionLostJobs(now, scope);
  const resultMisses = await reapResultMisses(now, scope);
  return { ackMisses, sessions, sessionLostJobs, resultMisses };
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
