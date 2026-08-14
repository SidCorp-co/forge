import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobEvents, jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { failReconcileRunForFailedJob } from '../skills/reconcile-service.js';
import { deviceRoom, projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { dispatchTickForProject } from './dispatch-tick.js';

/** Job statuses from which a single-job cancel is permitted. */
// cm:guard cancellable, NOT slot-occupying — `held` belongs here (a human may always stop a step that will never run) but is deliberately excluded from the runner-cap CTEs in dispatch-gates.ts. Reusing this set for load accounting would count held jobs against the cap and re-create the wedge RFC 0002 removed.
export const CANCELLABLE_STATUSES = new Set(['queued', 'dispatched', 'running', 'held']);

/**
 * Statuses with no device attached yet, so a cancel flips them straight to
 * `cancelled` instead of asking a runner to stop.
 */
// cm:guard `held` has no device by construction — `holdJobForReason` inserts the successor row without one, so it can never take the device-push branch. If a future hold path ever dispatches before holding, this set is the thing that must change with it.
const NO_DEVICE_STATUSES = new Set(['queued', 'held']);

/**
 * Transport-neutral failure raised by {@link cancelJob}. Callers map `code` to
 * their own surface: REST → HTTP 404/409, MCP → `Error('CODE: message')`.
 */
export class JobCancelError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'NOT_CANCELLABLE',
    message: string,
  ) {
    super(message);
    this.name = 'JobCancelError';
  }
}

export interface CancelJobOptions {
  /** User id of the acting principal — recorded in the audit event. */
  actorUserId: string;
  /** Human/automation-supplied reason — recorded in the audit event. */
  reason: string;
  /** Which surface invoked the cancel. */
  source: 'rest' | 'mcp';
}

export interface CancelJobResult {
  jobId: string;
  status: string;
  cancellationRequested: boolean;
}

/**
 * Authoritative single-job cancel shared by REST `POST /jobs/:id/cancel` and
 * the `forge_jobs.cancel` MCP tool — the audited manual escape hatch (ISS-442
 * C0). Intentionally does NOT inspect the parent pipeline_run status: a
 * queued/dispatched job orphaned under an ALREADY-terminal run must cancel
 * cleanly (replacing the raw-SQL surgery that was the only previous cure).
 *
 * Behaviour mirrors the former inline REST handler:
 * - `queued` / `held` → CAS to `cancelled` (guarded on the observed status),
 *   then sync the agent session, broadcast `job.cancelled`, re-tick dispatch,
 *   and refresh pipeline health.
 * - `dispatched`/`running` → set `cancellationRequested`, push `job.cancel` to
 *   the owning device, and broadcast `job.cancelRequested`; the runner's
 *   `/complete` finalises the terminal flip.
 *
 * Every successful cancel writes ONE `job_events` row (`kind='intervention'`)
 * carrying actor + reason so the interventions metric (C6) can count audited
 * manual interventions per issue. The status mutation and the audit row commit
 * in a single transaction.
 *
 * @throws {JobCancelError} `NOT_FOUND` if the job does not exist;
 *   `NOT_CANCELLABLE` if it is not in a cancellable status (or the CAS lost a race).
 */
// cm:why `held` is cancellable here so clearing one dead step no longer requires cancelling its whole run — that was the only route before (the cascade covers `held`), and it parked the issue at `on_hold` as a side effect, which is a far bigger hammer than the operator asked for
export async function cancelJob(jobId: string, opts: CancelJobOptions): Promise<CancelJobResult> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new JobCancelError('NOT_FOUND', 'job not found');

  if (!CANCELLABLE_STATUSES.has(job.status)) {
    throw new JobCancelError('NOT_CANCELLABLE', 'job is not cancellable');
  }

  const previousStatus = job.status;

  if (NO_DEVICE_STATUSES.has(job.status)) {
    const updated = await db.transaction(async (tx) => {
      const [row] = await applyKernelTransition(tx, {
        entity: 'job',
        to: 'cancelled',
        set: { finishedAt: new Date(), cancellationRequested: true },
        where: and(eq(jobs.id, jobId), eq(jobs.status, previousStatus)),
        fromStatus: previousStatus,
        reason: opts.reason,
        actor: { type: 'user', id: opts.actorUserId },
        source: 'cancel',
      });
      if (!row) return null;
      await insertInterventionEvent(tx, row.id, row.issueId, previousStatus, opts);
      return row;
    });
    if (!updated) {
      throw new JobCancelError('NOT_CANCELLABLE', 'job state changed mid-request');
    }

    await syncAgentSessionLifecycle(updated, 'cancelled');

    // cm:edge sideeffect -> packages/core/src/skills/reconcile-service.ts — mirrors the finalize-failure.ts:248 hook so a cancelled reconcile/verify_skill job never leaves reconcile_runs stuck at pending (ISS-808)
    await failReconcileRunForFailedJob(updated).catch((err) =>
      logger.warn(
        { err, jobId: updated.id, type: updated.type },
        'cancelJob: failReconcileRunForFailedJob failed',
      ),
    );

    roomManager.publish(projectRoom(updated.projectId), {
      event: 'job.cancelled',
      data: { jobId: updated.id, status: 'cancelled' },
    });

    void dispatchTickForProject(updated.projectId);

    // ISS-164 — keep pipeline-health rollups current.
    if (updated.issueId) {
      await publishPipelineHealthChanged(updated.projectId, [updated.issueId]);
    }

    return {
      jobId: updated.id,
      status: updated.status,
      cancellationRequested: updated.cancellationRequested,
    };
  }

  // Dispatched/running → mark request, push to device, let /complete finalize.
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(jobs)
      .set({ cancellationRequested: true })
      .where(eq(jobs.id, jobId))
      .returning();
    if (!row) return null;
    await insertInterventionEvent(tx, row.id, row.issueId, previousStatus, opts);
    return row;
  });
  if (!updated) throw new JobCancelError('NOT_FOUND', 'job not found');

  if (updated.deviceId) {
    roomManager.publish(deviceRoom(updated.deviceId), {
      event: 'job.cancel',
      data: { jobId: updated.id },
    });
  }
  roomManager.publish(projectRoom(updated.projectId), {
    event: 'job.cancelRequested',
    data: { jobId: updated.id },
  });

  return {
    jobId: updated.id,
    status: updated.status,
    cancellationRequested: updated.cancellationRequested,
  };
}

/**
 * Append the audited `intervention` event inside an open transaction. Uses the
 * same advisory-lock + `MAX(seq)+1` frontier as the job_events POST route
 * (jobs/events-routes.ts) so the server-assigned seq stays monotonic under
 * concurrent inserts; the lock auto-releases at COMMIT/ROLLBACK.
 */
async function insertInterventionEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  jobId: string,
  issueId: string | null,
  previousStatus: string,
  opts: CancelJobOptions,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${jobId}))`);
  const maxRows = await tx.execute<{ max_seq: number | string | null }>(
    sql`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM job_events WHERE job_id = ${jobId}`,
  );
  const first = maxRows[0] as { max_seq: number | string | null } | undefined;
  const nextSeq = Number(first?.max_seq ?? 0) + 1;

  await tx.insert(jobEvents).values({
    jobId,
    kind: 'intervention',
    data: {
      action: 'cancel',
      actor: opts.actorUserId,
      reason: opts.reason,
      source: opts.source,
      previousStatus,
      issueId,
    },
    seq: nextSeq,
  });
}
