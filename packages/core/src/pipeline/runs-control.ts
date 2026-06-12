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
import { type IssueStatus, issues, pipelineRuns, projects } from '../db/schema.js';
import { type DeviceLite, applyStatusTransition } from '../issues/apply-transition.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { broadcastAbortEvents, cascadeCancelChildJobs } from './runs-cascade.js';

/**
 * ISS-411 — issue statuses an operator cancel must NOT disturb. `on_hold` is
 * already parked; `closed`/`released` are terminal (parking them would re-open
 * a finished issue). Everything else is "actionable" and would be re-picked by
 * the orchestrator the moment the run dies, so cancel parks it at `on_hold`.
 */
const CANCEL_PARK_SKIP_STATUSES = new Set<IssueStatus>(['on_hold', 'closed', 'released']);

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
 * ISS-411 — after an operator cancels an issue-scoped run, atomically park the
 * linked issue at `on_hold` so the orchestrator does not immediately re-pick it
 * (autoTriage/autoCode dispatch only from "actionable" statuses; `on_hold` has
 * no `STATUS_TO_JOB_TYPE` mapping). Without this, cancel silently re-dispatched
 * a fresh run seconds later. Runs AFTER the cancel commit (applyStatusTransition
 * opens its own transaction) and is best-effort: a failure here must not fail
 * the cancel itself. The transition uses the project creator (`projects.createdBy`,
 * audit-only) as a `device` actor
 * (mirrors the system-transition pattern in `jobs/finalize-failure.ts`), so the
 * orchestrator's ISS-411 guard treats a later non-`user` advance out of
 * `on_hold` as inert — only a human Resume re-engages the pipeline.
 */
async function parkIssueOnCancel(run: PipelineRunRow): Promise<void> {
  if (run.kind !== 'issue' || !run.issueId) return;
  try {
    const [row] = await db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        status: issues.status,
        reopenCount: issues.reopenCount,
        createdBy: projects.createdBy,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(eq(issues.id, run.issueId))
      .limit(1);
    if (!row) return;
    if (CANCEL_PARK_SKIP_STATUSES.has(row.status)) return;

    const actorId = row.createdBy ?? run.projectId;
    const device: DeviceLite = { id: actorId, ownerId: actorId };
    await applyStatusTransition(
      { id: row.id, projectId: row.projectId, status: row.status, reopenCount: row.reopenCount },
      'on_hold',
      device,
      { skip: true },
    );
  } catch (err) {
    logger.warn(
      { err, runId: run.id, issueId: run.issueId },
      'cancel: park-issue-on_hold failed (run already cancelled)',
    );
  }
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
    const [updatedRun] = await applyKernelTransition(tx, {
      entity: 'run',
      to: 'cancelled',
      set: { finishedAt: cancelNow, updatedAt: cancelNow },
      where: and(
        eq(pipelineRuns.id, runId),
        inArray(pipelineRuns.status, ['running', 'paused']),
      ),
      fromStatus: 'open',
      reason: FAILURE_REASON_PIPELINE_CANCELLED,
      actor: { type: 'user' },
      source: 'runs-control',
    });

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
    // ISS-411 — make the cancel authoritative: park the linked issue so it does
    // not silently auto-resume. Best-effort; never fails the cancel.
    await parkIssueOnCancel(result.run);
  }

  return {
    run: result.run,
    cancelledJobIds: result.cancelledJobIds,
    abortedSessionIds: result.abortedSessionIds,
    deviceIdsNotified: result.deviceIdsNotified,
  };
}
