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

  // cm:guard the CAS on `status='queued'` is what keeps a worker claiming concurrently from being stomped, and `dispatchedAt` falls back to `createdAt` because rows predating that column have none — without the fallback every one of them reads as queued since the epoch and is failed on the first tick.
  // cm:guard ISS-1101 — `lastHeartbeatAt IS NULL` is what makes this arm's own wedge sentence TRUE, and it is not an optimisation. The queued predicate had no activity term because the status flip WAS one: any beat moved the row to `running` and so out of reach. Now that `events-routes.ts` flips only on evidence a turn began, a claimed-and-beating session stays `queued`, and without this term it would be failed as never-claimed while its worker held a pane and a pasted prompt.
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

  /*
   * ISS-1101 — the other half of the queue hop: a session a worker DID claim,
   * that reported, and that never reported a turn beginning.
   *
   * It takes `heartbeatMs` rather than `queueMs` because it is the quiet-clock
   * proposition and not the queue one: the row is bounded by silence, exactly
   * as the heartbeat hop in `loop-monitor.ts` is, and the only thing separating
   * the two is which status the box went quiet in. That is also what keeps it out of a
   * race with the runner's own first-turn window (`turn_evidence.rs`,
   * ISS-1096), which fires while the box is ALIVE and beating — a condition
   * this arm requires the negation of. Where the two do overlap (a live box
   * whose reports stopped reaching core) they name the SAME cause, in either
   * order, because `agent-session-link.ts#deriveSessionFailure` classifies the
   * box's own sentence onto `turn_never_reported` through `CAUSE_RULES`.
   */
  // cm:guard the cause names what CORE observed and deliberately not what it usually means: this hop cannot see the pane, so silence proves no turn was REPORTED and never that none ran. `agent_never_started` would be the same over-assertion `events-routes.ts` was just stopped from making, one column over.
  // cm:guard no `awaiting_input` exemption here, unlike `loop-monitor.ts`'s heartbeat hop, and the asymmetry is deliberate: a park implies a turn ran, so a park on a QUEUED session is a contradiction the record should not be allowed to sit in forever — `park-deadline.ts`'s two clocks both read `running` and would never reach it.
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
