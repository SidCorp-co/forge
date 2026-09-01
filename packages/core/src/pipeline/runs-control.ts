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
import type { TransitionActor } from '../issues/actor-agency.js';
import { transitionIssueStatus } from '../issues/apply-transition.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { hooks } from './hooks.js';
import { pauseRun, resumeRun } from './run-pause.js';
import { cascadeCancelChildJobs, type JobRow, requestKillsForCascade } from './runs-cascade.js';

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
  /** Whether the linked issue was parked at `on_hold` by this cancel. */
  issueParked: boolean;
};

export interface CancelPipelineRunOptions {
  /** The human who asked. Recorded on the run flip AND the issue park. */
  actorUserId?: string;
  /**
   * Park the linked issue at `on_hold`. Defaults to TRUE — "stop working on
   * this" is the common intent and the historical behaviour.
   *
   * Pass `false` for "cancel this run so a clean one can start": the issue
   * keeps its status and the orchestrator opens a replacement run within
   * seconds, which for that intent is the point rather than a bug.
   */
  parkIssue?: boolean;
}

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
 * `cancelled`). Write + side effects via the shared pause writer
 * (`run-pause.ts`).
 */
export async function pausePipelineRun(runId: string): Promise<PipelineRunRow> {
  const updated = await pauseRun({ runId });
  if (updated) return updated;
  const current = await selectRun(runId);
  if (!current) throw notFound();
  if (current.status === 'paused') return current;
  throw conflict(current.status);
}

/**
 * Flip a paused run back to `running`. Idempotent on already-`running`.
 * Throws `CONFLICT` for any terminal status. Write + side effects via the
 * shared pause writer (`run-pause.ts`).
 */
export async function resumePipelineRun(runId: string): Promise<PipelineRunRow> {
  const updated = await resumeRun({ runId });
  if (updated) return updated;
  const current = await selectRun(runId);
  if (!current) throw notFound();
  if (current.status === 'running') return current;
  throw conflict(current.status);
}

/**
 * Park the cancelled run's issue at `on_hold`. Returns whether it parked.
 *
 * Runs AFTER the cancel commits (the transition opens its own transaction) and
 * is best-effort: a failure here must not fail the cancel.
 */
// cm:guard the brake is that `on_hold` has no `STATUS_TO_JOB_TYPE` mapping, NOT the actor — every other status a cancelled run can leave behind is actionable, so the orchestrator opens a replacement run seconds later and the cancel achieves nothing (ISS-411). A future edit that parks somewhere actionable restores that silent re-dispatch.
// cm:guard record the human who cancelled, never a synthesized device — a device actor writes `isAi: true` and attributes the park to `projects.createdBy`, which drops it out of the interventions metric that counts user-actor transitions. The device fallback is for callers with no user in scope, not the normal path.
async function parkIssueOnCancel(run: PipelineRunRow, actorUserId?: string): Promise<boolean> {
  if (run.kind !== 'issue' || !run.issueId) return false;
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
    if (!row) return false;
    if (CANCEL_PARK_SKIP_STATUSES.has(row.status)) return false;

    const fallbackId = row.createdBy ?? run.projectId;
    const actor: TransitionActor = actorUserId
      ? { type: 'user', id: actorUserId }
      : { type: 'device', id: fallbackId, ownerId: fallbackId };
    await transitionIssueStatus(
      { id: row.id, projectId: row.projectId, status: row.status, reopenCount: row.reopenCount },
      'on_hold',
      actor,
      { skip: true },
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, runId: run.id, issueId: run.issueId },
      'cancel: park-issue-on_hold failed (run already cancelled)',
    );
    return false;
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
export async function cancelPipelineRun(
  runId: string,
  opts: CancelPipelineRunOptions = {},
): Promise<CancelPipelineRunResult> {
  const cancelNow = new Date();

  const result = await db.transaction(async (tx) => {
    const [updatedRun] = await applyKernelTransition(tx, {
      entity: 'run',
      to: 'cancelled',
      set: { finishedAt: cancelNow, updatedAt: cancelNow },
      where: and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ['running', 'paused'])),
      fromStatus: 'open',
      reason: FAILURE_REASON_PIPELINE_CANCELLED,
      actor: { type: 'user', ...(opts.actorUserId ? { id: opts.actorUserId } : {}) },
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
          killableJobs: [] as JobRow[],
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
      killableJobs: cascade.killableJobs,
    };
  });

  let issueParked = false;
  if (result.broadcast) {
    broadcastRunStatus(result.run);
    // cm:guard `fromStatus: 'running'` is FALSE when the run was `paused`, and on this path that is a new false statement rather than an inherited one — before this call an operator cancel emitted nothing, so `sentry-breadcrumbs.ts` now renders "running -> cancelled" for a run that was paused, on the surface the maintainer uses to reconstruct a run's history without the DB. Priced, not free: THREE of the four subscribers DECIDE on `toStatus` and never read this field; the fourth, `sentry-breadcrumbs.ts`, decides on nothing and only RENDERS `fromStatus`, which is exactly where the cost lands. `emitCloseHook` in pipeline/runs.ts already records the same fixed value for the identical case. The exit condition is the honest value threaded through `applyKernelTransition`'s returning shape — NOT a pre-select here, which is a second round-trip and a second convention.
    // cm:guard emit AFTER the transaction commits, and never skip it — an operator cancel is a terminal run transition, and three subscribers already assume every one of them reaches this hook: `release-batch/claim-subscriber.ts` names "operator cancelPipelineRun → runs-control.ts" in its own header (an assumption that was false until this call existed, which is why ISS-764 needed a sweeper backstop), `memory/candidates-observer.ts` mines terminal issue runs, and `pipeline/paused-run-wedge-resolve.ts` clears the frozen-queue notification whose ONLY other clearer is a resume.
    await hooks.emit('pipelineRunStatusChanged', {
      runId: result.run.id,
      projectId: result.run.projectId,
      issueId: result.run.issueId,
      kind: result.run.kind,
      fromStatus: 'running',
      toStatus: 'cancelled',
      currentStep: result.run.currentStep,
      cascadedJobIds: result.cancelledJobIds,
    });
    await requestKillsForCascade(result.killableJobs, FAILURE_REASON_PIPELINE_CANCELLED);
    if (opts.parkIssue ?? true) {
      issueParked = await parkIssueOnCancel(result.run, opts.actorUserId);
    }
  }

  return {
    run: result.run,
    cancelledJobIds: result.cancelledJobIds,
    abortedSessionIds: result.abortedSessionIds,
    deviceIdsNotified: result.deviceIdsNotified,
    issueParked,
  };
}
