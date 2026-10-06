// Reaping one-shot runs nothing will finish.

import { MASTER_SESSION_KIND, RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { oneShotRunOutcome } from '@forge/contracts/run-machine';
import { SESSION_SILENCE_REAP_MS } from '@forge/contracts/run-standing';
import { LIVE_SESSION_STATUSES } from '@forge/contracts/session-machine';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterCommit, db } from '../db/client.js';
import { agentSessions, pipelineRuns } from '../db/schema.js';
import { kindTuple } from '../db/session-vocabulary.js';
import { logger } from '../lib/logger.js';
import {
  broadcastSessionEvent,
  getLoopThresholds,
  parkedOnAHuman,
  SWEEP_SESSION_COLUMNS,
  transitionSessions,
} from './ports.js';
import { closeRunIfOneShotInTx } from './runs.js';
import type { SweepScope } from './sweeper.js';

export interface OneShotRunReapResult {
  reaped: number;
}

export async function reapOrphanedOneShotRuns(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<OneShotRunReapResult> {
  const { heartbeatMs } = getLoopThresholds();
  const cutoffIso = new Date(now.getTime() - heartbeatMs).toISOString();
  // a run session or a master is failed for silence by its own reaper at the session reap, so this
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
      // The run is locked before its sessions move, and they and its close are one transaction:
      // committed apart, a failed close left the sessions ended under a run still open (ISS-219).
      const closed = await db.transaction(async (tx) => {
        const [open] = await tx
          .select({ id: pipelineRuns.id })
          .from(pipelineRuns)
          .where(
            and(eq(pipelineRuns.id, row.id), inArray(pipelineRuns.status, ['running', 'paused'])),
          )
          .for('update');
        if (!open) return false;
        // A session already completed or failed is left as-is — the run still
        // needs closing.
        const flipped = (
          await transitionSessions(tx, {
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
        afterCommit(() => {
          for (const s of flipped) {
            void broadcastSessionEvent(s.id, s.projectId, s.deviceId, 'agent-session.status', {
              status: 'failed',
              failureReason: 'heartbeat_timeout',
            }).catch((err: unknown) =>
              logger.warn(
                { err, sessionId: s.id },
                'one-shot-reap: the session push was not written',
              ),
            );
          }
        });

        const sessions = await tx
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

        return closeRunIfOneShotInTx(tx, row.id, outcome, {
          code: 'heartbeat_timeout',
          detail: `its sessions stopped heartbeating and the sweeper failed them; none had completed`,
        });
      });
      if (!closed) continue;
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
