import { RUN_MACHINE } from '@forge/contracts/run-machine';

/**
 * ISS-102 — pause / resume / cancel transitions for `pipeline_runs`.
 *
 * REST handlers (`pipeline/runs-routes.ts`) and the chat tool
 * (`pipeline/tool-runs.ts`) both call into these helpers so the
 * transition semantics live in one place.
 */

import type { ActorAgency } from '@forge/contracts/permissions';
import type { Refusal } from '@forge/contracts/refusal';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, pipelineRuns, projects } from '../db/schema.js';
import type { TransitionActor } from '../issues/index.js';
import { transitionIssueStatus } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { RefusalError } from '../lib/refusal.js';
import { type KernelActor, transition } from '../lifecycle/index.js';
import { refusePipeline } from './refuse.js';
import { pauseRun, resumeRun } from './run-pause.js';
import { cascadeCancelChildJobs, type JobRow, requestKillsForCascade } from './runs-cascade.js';

/**
 * ISS-411 — issue statuses an operator cancel must NOT disturb. `on_hold` is
 * already parked; `closed`/`dropped`/`awaiting_release` are done with the run (parking them would
 * re-open a finished issue), and `draft` was never admitted. Everything else is "actionable" and
 * would be re-picked the moment the run dies, so cancel parks it at `on_hold`.
 */
const CANCEL_PARK_SKIP_STATUSES = new Set<IssueStatus>([
  'on_hold',
  'closed',
  'dropped',
  'awaiting_release',
  'draft',
]);

const CANCEL_PARK_REASON =
  'The run working this issue was cancelled, so the issue is paused here rather than taken up again on its own. Lift the hold to send it back where it was.';

export type PipelineRunRow = typeof pipelineRuns.$inferSelect;

type CancelPipelineRunResult = {
  run: PipelineRunRow;
  cancelledJobIds: string[];
  abortedSessionIds: string[];
  deviceIdsNotified: string[];
  /** Whether the linked issue was parked at `on_hold` by this cancel. */
  issueParked: boolean;
  /** Why the park was refused, when it was: the run is cancelled and the issue kept its status. */
  parkRefused: Refusal | null;
};

interface CancelPipelineRunOptions {
  /** The user the cancel is attributed to. Recorded on the run flip AND the issue park. */
  actorUserId?: string;
  actorAgency: ActorAgency;
  /**
   * Park the linked issue at `on_hold`. Defaults to TRUE — "stop working on
   * this" is the common intent and the historical behaviour.
   *
   * Pass `false` for "cancel this run so a clean one can start": the issue
   * keeps its status, so a master takes it up again on its next pass.
   */
  parkIssue?: boolean;
}

const FAILURE_REASON_PIPELINE_CANCELLED = 'pipeline_cancelled';

function notFound(runId: string): Error {
  return refusePipeline('PIPELINE_RUN_NOT_FOUND', `pipeline run ${runId} was not found`);
}

function runTerminal(current: PipelineRunRow['status']): Error {
  return refusePipeline(
    'PIPELINE_RUN_TERMINAL',
    `this run is already ${current}, so it is neither paused, resumed nor cancelled again`,
  );
}

async function selectRun(runId: string): Promise<PipelineRunRow | null> {
  const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1);
  return row ?? null;
}

/**
 * Flip a running run to `paused`. Idempotent on already-`paused` runs.
 * Refuses `PIPELINE_RUN_TERMINAL` for any terminal status (`completed`, `failed`,
 * `cancelled`). Write + side effects via the shared pause writer
 * (`run-pause.ts`).
 */
export async function pausePipelineRun(runId: string, actor: KernelActor): Promise<PipelineRunRow> {
  const updated = await pauseRun({ runId, actor });
  if (updated) return updated;
  const current = await selectRun(runId);
  if (!current) throw notFound(runId);
  if (current.status === 'paused') return current;
  throw runTerminal(current.status);
}

export async function resumePipelineRun(
  runId: string,
  actor: KernelActor,
): Promise<PipelineRunRow> {
  const updated = await resumeRun({ runId, actor });
  if (updated) return updated;
  const current = await selectRun(runId);
  if (!current) throw notFound(runId);
  if (current.status === 'running') return current;
  throw runTerminal(current.status);
}

type ParkOutcome = { issueParked: boolean; parkRefused: Refusal | null };

/**
 * Park the cancelled run's issue at `on_hold`.
 *
 * Runs AFTER the cancel commits (the transition opens its own transaction), so
 * a refused or failed park does not undo the cancel: it is returned by name for
 * the caller to see that the issue kept an actionable status.
 */
async function parkIssueOnCancel(
  run: PipelineRunRow,
  agency: ActorAgency,
  actorUserId?: string,
): Promise<ParkOutcome> {
  const notParked: ParkOutcome = { issueParked: false, parkRefused: null };
  if (run.kind !== 'issue' || !run.issueId) return notParked;
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
    if (!row) return notParked;
    if (CANCEL_PARK_SKIP_STATUSES.has(row.status)) return notParked;

    const fallbackId = row.createdBy ?? run.projectId;
    const actor: TransitionActor = actorUserId
      ? { type: 'user', id: actorUserId, agency }
      : { type: 'device', id: fallbackId, ownerId: fallbackId };
    await transitionIssueStatus(
      { id: row.id, projectId: row.projectId, status: row.status, reopenCount: row.reopenCount },
      'on_hold',
      actor,
      { transitionReason: CANCEL_PARK_REASON, reason: 'run_cancelled' },
    );
    return { issueParked: true, parkRefused: null };
  } catch (err) {
    logger.warn(
      { err, runId: run.id, issueId: run.issueId },
      'cancel: park-issue-on_hold refused (run already cancelled)',
    );
    const parkRefused: Refusal =
      err instanceof RefusalError && err.refusals[0]
        ? err.refusals[0]
        : {
            code: 'ISSUE_PARK_FAILED',
            path: '',
            detail: err instanceof Error ? err.message : String(err),
          };
    return { issueParked: false, parkRefused };
  }
}

export async function cancelPipelineRun(
  runId: string,
  opts: CancelPipelineRunOptions,
): Promise<CancelPipelineRunResult> {
  const cancelNow = new Date();

  const result = await db.transaction(async (tx) => {
    const [updatedRun] = (
      await transition(tx, RUN_MACHINE, {
        to: 'cancelled',
        set: { finishedAt: cancelNow, updatedAt: cancelNow },
        where: and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ['running', 'paused'])),
        reason: FAILURE_REASON_PIPELINE_CANCELLED,
        actor: {
          type: 'user',
          agency: opts.actorAgency,
          ...(opts.actorUserId ? { id: opts.actorUserId } : {}),
        },
        source: 'runs-control',
      })
    ).rows;

    if (!updatedRun) {
      const [current] = await tx
        .select()
        .from(pipelineRuns)
        .where(eq(pipelineRuns.id, runId))
        .limit(1);
      if (!current) throw notFound(runId);
      if (current.status === 'cancelled') {
        return {
          run: current,
          cancelledJobIds: [] as string[],
          abortedSessionIds: [] as string[],
          deviceIdsNotified: [] as string[],
          flipped: false,
          killableJobs: [] as JobRow[],
        };
      }
      throw runTerminal(current.status);
    }

    const cascade = await cascadeCancelChildJobs(tx, runId, FAILURE_REASON_PIPELINE_CANCELLED);

    return {
      run: updatedRun,
      cancelledJobIds: cascade.cancelledJobIds,
      abortedSessionIds: cascade.abortedSessionIds,
      deviceIdsNotified: Array.from(new Set([...cascade.deviceBySession.values()])),
      flipped: true,
      killableJobs: cascade.killableJobs,
    };
  });

  let park: ParkOutcome = { issueParked: false, parkRefused: null };
  if (result.flipped) {
    await requestKillsForCascade(result.killableJobs, FAILURE_REASON_PIPELINE_CANCELLED);
    if (opts.parkIssue ?? true) {
      park = await parkIssueOnCancel(result.run, opts.actorAgency, opts.actorUserId);
    }
  }

  return {
    run: result.run,
    cancelledJobIds: result.cancelledJobIds,
    abortedSessionIds: result.abortedSessionIds,
    deviceIdsNotified: result.deviceIdsNotified,
    ...park,
  };
}
