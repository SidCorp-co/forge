import { MASTER_SESSION_KIND, RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { oneShotRunOutcome } from '@forge/contracts/run-machine';
import { SESSION_SILENCE_REAP_MS } from '@forge/contracts/run-standing';
import { LIVE_SESSION_STATUSES } from '@forge/contracts/session-machine';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import {
  CLIENT_SESSION_KINDS,
  kindTuple,
  PIPELINE_SESSION_KINDS,
} from '../db/session-vocabulary.js';
import { logger } from '../observability/logger.js';
import {
  broadcastSessionEvent,
  getLoopThresholds,
  killGraceMs,
  type LoopScope,
  parkedOnAHuman,
  SWEEP_SESSION_COLUMNS,
  transitionSessions,
} from './ports.js';
import { closeOpenRunForIssue, closeRunIfOneShot } from './runs.js';
import { emitPipelineWedge } from './wedge.js';

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
export async function recordQueueSnapshots(): Promise<number> {
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

type SweepScope = LoopScope;

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
  const { queueMs, heartbeatMs } = getLoopThresholds();
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

function orphanedJobAlarmQuery(now: Date = new Date(), scope: SweepScope = {}): SQL {
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

function neverClaimedAlarmQuery(now: Date = new Date(), scope: SweepScope = {}): SQL {
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
        'Inspect core logs around this tick for a thrown miss-handler; if the row is genuinely wedged, use the single-job cancel escape hatch (POST /api/jobs/:id/cancel).',
    });
  }
}

export async function reapOrphanedOneShotRuns(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<OneShotRunReapResult> {
  const { heartbeatMs } = getLoopThresholds();
  const cutoffIso = new Date(now.getTime() - heartbeatMs).toISOString();
  // cm:guard a run session or a master is failed for silence by its own reaper at the session reap, so this
  // sweep may not close its run sooner, or a silent run could never read stuck first (ISS-109)
  const boxSilenceIso = new Date(now.getTime() - SESSION_SILENCE_REAP_MS).toISOString();
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
              s.kind IN ${kindTuple([RUN_SESSION_KIND, MASTER_SESSION_KIND])}
              AND COALESCE(s.last_heartbeat_at, s.started_at, s.updated_at, s.created_at) >= ${boxSilenceIso}
            )
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
      const flipped = (
        await transitionSessions(db, {
          returning: SWEEP_SESSION_COLUMNS,
          to: 'failed',
          set: { failureReason: 'heartbeat_timeout', updatedAt: now },
          where: and(
            eq(agentSessions.pipelineRunId, row.id),
            inArray(agentSessions.status, LIVE_SESSION_STATUSES),
          ),
          reason: 'heartbeat_timeout',
          actor: { type: 'sweeper' },
          source: 'sweeper',
        })
      ).rows;
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
      const outcome = oneShotRunOutcome({ anyCompleted, anyFailed });

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

  const flipped = (
    await transitionSessions(db, {
      returning: SWEEP_SESSION_COLUMNS,
      to: 'completed',
      set: { failureReason: null, failureDetail: null, updatedAt: now },
      where: and(
        inArray(agentSessions.id, ids),
        inArray(agentSessions.status, LIVE_SESSION_STATUSES),
      ),
      reason: 'chat_idle_timeout',
      actor: { type: 'sweeper' },
      source: 'sweeper',
    })
  ).rows;

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
  const { heartbeatMs } = getLoopThresholds();
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
