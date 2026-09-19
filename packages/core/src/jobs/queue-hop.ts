/**
 * The queue hop of the session axis (ISS-449 hop 2), in its two arms.
 *
 * It lives beside the loop monitor rather than inside it because ISS-1101 gave
 * the hop a second arm, and the two only make sense read together: they split
 * one population on one column, in opposite senses, and each writes a reason
 * that is true of its own half and false of the other. Put a row in both and
 * the record lies whichever arm wins.
 *
 * `lookupIssueForRun` and `broadcastZombieTransition` come with them: every
 * session-axis arm calls both, and the queue hop is the first caller, so they
 * are exported from here rather than left behind as an import cycle.
 */

import type { SQL } from 'drizzle-orm';
import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, pipelineRuns } from '../db/schema.js';
import { applyKernelTransition, SWEEP_SESSION_COLUMNS } from '../lifecycle/transition.js';
import { emitPipelineWedge } from '../pipeline/wedge.js';
import { broadcastSessionEvent } from './agent-session-link.js';
import { PIPELINE_METADATA_TYPES } from './session-kinds.js';

/** Resolve the linked issue for a session's wedge event via its pipeline_run
 *  (sessions carry no issue_id of their own). Best-effort. */
export async function lookupIssueForRun(pipelineRunId: string | null): Promise<string | null> {
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

export function broadcastZombieTransition(
  sessionId: string,
  projectId: string,
  deviceId: string | null,
  reason: 'queue_timeout' | 'turn_never_reported' | 'heartbeat_timeout' | 'no_client_ack',
): void {
  broadcastSessionEvent(sessionId, projectId, deviceId, 'agent-session.status', {
    status: 'failed',
    failureReason: reason,
  });
}

export interface QueueHopInput {
  now: Date;
  /** Nothing has ever reported on a session dispatched before this. */
  queueCutoff: Date;
  /** A session that reported has been silent since before this. */
  quietCutoff: Date;
  projectFilter: SQL | undefined;
}

export interface QueueHopResult {
  queueTimedOut: number;
  turnNeverReported: number;
}

/** Both arms, in one pass each, over the `queued` pipeline/pm sessions. */
export async function reapQueueHop(input: QueueHopInput): Promise<QueueHopResult> {
  const { now, queueCutoff, quietCutoff, projectFilter } = input;

  const queuedFailed = await applyKernelTransition(db, {
    entity: 'session',
    returning: SWEEP_SESSION_COLUMNS,
    to: 'failed',
    set: { failureReason: 'queue_timeout', updatedAt: now },
    where: and(
      eq(agentSessions.status, 'queued'),
      sql`${agentSessions.lastHeartbeatAt} IS NULL`,
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

  const neverReportedFailed = await applyKernelTransition(db, {
    entity: 'session',
    returning: SWEEP_SESSION_COLUMNS,
    to: 'failed',
    set: { failureReason: 'turn_never_reported', updatedAt: now },
    where: and(
      eq(agentSessions.status, 'queued'),
      isNotNull(agentSessions.lastHeartbeatAt),
      lt(agentSessions.lastHeartbeatAt, quietCutoff),
      sql`${agentSessions.metadata}->>'type' IN ${PIPELINE_METADATA_TYPES}`,
      ...(projectFilter ? [projectFilter] : []),
    ),
    fromStatus: 'queued',
    reason: 'turn_never_reported',
    actor: { type: 'sweeper' },
    source: 'loop-monitor',
  });

  for (const z of neverReportedFailed) {
    broadcastZombieTransition(z.id, z.projectId, z.deviceId, 'turn_never_reported');
    await emitPipelineWedge({
      projectId: z.projectId,
      issueId: await lookupIssueForRun(z.pipelineRunId),
      hop: 'heartbeat',
      entity: 'session',
      entityId: z.id,
      reason: 'the session stopped reporting before anything reported a turn beginning',
      action:
        "Open the runner's pane for this job: the usual cause is a prompt that was pasted and never submitted. Rerun once you know which.",
    });
  }

  return {
    queueTimedOut: queuedFailed.length,
    turnNeverReported: neverReportedFailed.length,
  };
}
