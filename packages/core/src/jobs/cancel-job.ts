import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobEvents, jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { deviceRoom, projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { dispatchTickForProject } from './dispatch-tick.js';

/** Job statuses from which a single-job cancel is permitted. */
export const ACTIVE_STATUSES = new Set(['queued', 'dispatched', 'running']);

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
 * - `queued` → CAS to `cancelled` (guarded on `status='queued'`), then sync the
 *   agent session, broadcast `job.cancelled`, free a dispatch slot, and refresh
 *   pipeline health.
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
 *   `NOT_CANCELLABLE` if it is not in an active status (or the CAS lost a race).
 */
export async function cancelJob(jobId: string, opts: CancelJobOptions): Promise<CancelJobResult> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new JobCancelError('NOT_FOUND', 'job not found');

  if (!ACTIVE_STATUSES.has(job.status)) {
    throw new JobCancelError('NOT_CANCELLABLE', 'job is not cancellable');
  }

  const previousStatus = job.status;

  // Queued, no device yet → transition straight to cancelled.
  if (job.status === 'queued') {
    const updated = await db.transaction(async (tx) => {
      const [row] = await applyKernelTransition(tx, {
        entity: 'job',
        to: 'cancelled',
        set: { finishedAt: new Date(), cancellationRequested: true },
        where: and(eq(jobs.id, jobId), eq(jobs.status, 'queued')),
        fromStatus: 'queued',
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

    roomManager.publish(projectRoom(updated.projectId), {
      event: 'job.cancelled',
      data: { jobId: updated.id, status: 'cancelled' },
    });

    // Cancelling a queued job frees a slot — re-tick.
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
