/**
 * ISS-102 — pause / resume / cancel transitions for `pipeline_runs`.
 *
 * REST handlers (`pipeline/runs-routes.ts`) and MCP tools
 * (`mcp/tools/forge-pipeline-runs.ts`) both call into these helpers so the
 * transition semantics live in one place. The dispatcher gate added in
 * ISS-101 already filters by `r.status = 'running'`, so flipping
 * `pipeline_runs.status` to `paused` or `cancelled` is the only mutation
 * needed to stop new jobs being picked. Cancel additionally cascades the
 * status onto queued/dispatched jobs of the run and notifies the device
 * room so any actively running agent session aborts cleanly.
 *
 * Status table:
 *   running   → pause  → paused  (broadcast)
 *   running   → resume → no-op   (return current)
 *   running   → cancel → cancelled + cascade jobs + abort device (broadcast)
 *   paused    → pause  → no-op   (return current)
 *   paused    → resume → running (broadcast)
 *   paused    → cancel → cancelled + cascade jobs (broadcast)
 *   cancelled → cancel → no-op   (idempotent)
 *   cancelled → pause/resume → CONFLICT
 *   completed | failed → any    → CONFLICT
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { broadcastAbortEvents, cascadeCancelChildJobs } from './runs-cascade.js';

export type PipelineRunRow = typeof pipelineRuns.$inferSelect;

export type CancelPipelineRunResult = {
  run: PipelineRunRow;
  cancelledJobIds: string[];
  abortedSessionIds: string[];
  deviceIdsNotified: string[];
};

const FAILURE_REASON_PIPELINE_CANCELLED = 'pipeline_cancelled';

function notFound(): Error {
  return new Error('NOT_FOUND: pipeline run not found');
}

function conflict(current: PipelineRunRow['status']): Error {
  return new Error(`CONFLICT: run already ${current}`);
}

async function selectRun(runId: string): Promise<PipelineRunRow | null> {
  const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1);
  return row ?? null;
}

function broadcastRunStatus(run: PipelineRunRow): void {
  roomManager.publish(projectRoom(run.projectId), {
    event: 'pipeline_run.status_changed',
    data: {
      runId: run.id,
      projectId: run.projectId,
      issueId: run.issueId,
      status: run.status,
      kind: run.kind,
      currentStep: run.currentStep,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
  });
}

/**
 * Flip a running run to `paused`. Idempotent on already-`paused` runs.
 * Throws `CONFLICT` for any terminal status (`completed`, `failed`,
 * `cancelled`).
 */
export async function pausePipelineRun(runId: string): Promise<PipelineRunRow> {
  const [updated] = await db
    .update(pipelineRuns)
    .set({ status: 'paused', updatedAt: new Date() })
    .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.status, 'running')))
    .returning();
  if (updated) {
    broadcastRunStatus(updated);
    return updated;
  }
  const current = await selectRun(runId);
  if (!current) throw notFound();
  if (current.status === 'paused') return current;
  throw conflict(current.status);
}

/**
 * Flip a paused run back to `running`. Idempotent on already-`running`.
 * Throws `CONFLICT` for any terminal status.
 */
export async function resumePipelineRun(runId: string): Promise<PipelineRunRow> {
  const [updated] = await db
    .update(pipelineRuns)
    .set({ status: 'running', updatedAt: new Date() })
    .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.status, 'paused')))
    .returning();
  if (updated) {
    broadcastRunStatus(updated);
    return updated;
  }
  const current = await selectRun(runId);
  if (!current) throw notFound();
  if (current.status === 'running') return current;
  throw conflict(current.status);
}

/**
 * Cancel a run. Status flips to `cancelled` (from `running` or `paused`),
 * any queued/dispatched jobs of the run are marked `cancelled`, linked
 * agent_sessions in non-terminal states transition to `failed` with
 * `failure_reason='pipeline_cancelled'`, and an `agent:abort` event is
 * published to each affected device room. Idempotent on already-cancelled
 * runs; throws `CONFLICT` on `completed`/`failed`.
 */
export async function cancelPipelineRun(runId: string): Promise<CancelPipelineRunResult> {
  const cancelNow = new Date();

  const result = await db.transaction(async (tx) => {
    const [updatedRun] = await tx
      .update(pipelineRuns)
      .set({ status: 'cancelled', finishedAt: cancelNow, updatedAt: cancelNow })
      .where(and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ['running', 'paused'])))
      .returning();

    if (!updatedRun) {
      const [current] = await tx
        .select()
        .from(pipelineRuns)
        .where(eq(pipelineRuns.id, runId))
        .limit(1);
      if (!current) throw notFound();
      if (current.status === 'cancelled') {
        return {
          run: current,
          cancelledJobIds: [] as string[],
          abortedSessionIds: [] as string[],
          deviceIdsNotified: [] as string[],
          broadcast: false,
        };
      }
      throw conflict(current.status);
    }

    const cascade = await cascadeCancelChildJobs(tx, runId, FAILURE_REASON_PIPELINE_CANCELLED);

    return {
      run: updatedRun,
      cancelledJobIds: cascade.cancelledJobIds,
      abortedSessionIds: cascade.abortedSessionIds,
      deviceIdsNotified: Array.from(new Set([...cascade.deviceBySession.values()])),
      broadcast: true,
      deviceBySession: cascade.deviceBySession,
    };
  });

  if (result.broadcast) {
    broadcastRunStatus(result.run);
    if (result.deviceBySession) {
      await broadcastAbortEvents(result.deviceBySession, FAILURE_REASON_PIPELINE_CANCELLED, runId);
    }
  }

  return {
    run: result.run,
    cancelledJobIds: result.cancelledJobIds,
    abortedSessionIds: result.abortedSessionIds,
    deviceIdsNotified: result.deviceIdsNotified,
  };
}
