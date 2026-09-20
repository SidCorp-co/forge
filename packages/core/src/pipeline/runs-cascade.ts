import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentSessions, jobs } from '../db/schema.js';
import { LIVE_JOB_STATUSES } from '../jobs/status-sets.js';
import { LIVE_SESSION_STATUSES } from '../lifecycle/status-sets.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type JobRow = typeof jobs.$inferSelect;

export type CascadeReason = 'pipeline_cancelled' | 'pipeline_completed' | 'pipeline_failed';

export interface CascadeResult {
  cancelledJobIds: string[];
  abortedSessionIds: string[];
  deviceBySession: Map<string, string>;
  /** ISS-785 — the terminal-flipped job rows that have a device to kill on.
   *  Pass to `requestKillsForCascade` AFTER the transaction commits (same
   *  "never publish/act on a rolled-back write" contract the old
   *  `agent:abort` fan-out had). */
  killableJobs: JobRow[];
}

// cm:flow release/reap after:close — closing the run reaps its child jobs, and on a `pipeline_completed` close the release job that is still running flips to done, NOT cancelled; that sentinel is why a successful release does not look like a cancelled one
export async function cascadeCancelChildJobs(
  tx: Tx | Db,
  runId: string,
  reason: CascadeReason,
): Promise<CascadeResult> {
  const now = new Date();

  // ISS-444 amendment 2 — the JOB axis mirrors the ISS-352 session branch
  // below: a run closing as `pipeline_completed` is the cascade's SUCCESS
  // sentinel, so the step's own still-active job resolves to `done` (NOT
  // cancelled). Genuine cancel/fail closes still cancel their active children.
  const completedSuccess = reason === 'pipeline_completed';
  const jobTarget: 'done' | 'cancelled' = completedSuccess ? 'done' : 'cancelled';
  const cancelledJobs = await applyKernelTransition(tx, {
    entity: 'job',
    to: jobTarget,
    set: completedSuccess
      ? { finishedAt: now, exitCode: 0, error: null, failureKind: null, failureReason: null }
      : {
          finishedAt: now,
          cancellationRequested: true,
          failureKind: 'infra',
          failureReason: reason,
        },
    where: and(eq(jobs.pipelineRunId, runId), inArray(jobs.status, [...LIVE_JOB_STATUSES])),
    fromStatus: 'active',
    reason,
    actor: { type: 'system' },
    source: 'cascade',
  });

  const cancelledJobIds = cancelledJobs.map((j) => j.id);
  const abortedSessionIds = cancelledJobs
    .map((j) => j.agentSessionId)
    .filter((id): id is string => typeof id === 'string');
  const deviceBySession = new Map<string, string>();
  for (const j of cancelledJobs) {
    if (j.agentSessionId && j.deviceId) deviceBySession.set(j.agentSessionId, j.deviceId);
  }

  if (!completedSuccess) {
    const reconcileJobs = cancelledJobs.filter(
      (j) => j.type === 'reconcile' || j.type === 'verify_skill',
    );
    if (reconcileJobs.length > 0) {
      const { failReconcileRunForFailedJob } = await import('../skills/reconcile-service.js');
      await Promise.all(
        reconcileJobs.map((j) =>
          failReconcileRunForFailedJob(j).catch((err) =>
            logger.error(
              { err, jobId: j.id, type: j.type },
              'cascadeCancelChildJobs: failReconcileRunForFailedJob failed',
            ),
          ),
        ),
      );
    }
  }

  if (abortedSessionIds.length > 0) {
    // ISS-352 — a run that closed as `pipeline_completed` did NOT fail. The
    // terminal pipeline step (forge-test → released, forge-release → closed)
    // sets the issue to a terminal status as its LAST action while its own
    // job/session is still `running`; the cascade then reaps that very session.
    // Mapping a success-close to `failed` produced the false-failed badge the
    // reporter saw on ISS-351's forge-test / forge-release sessions. Only
    // genuine failure/cancel closes should mark the leftover sessions failed.
    const sessionTarget: 'completed' | 'failed' = completedSuccess ? 'completed' : 'failed';
    await applyKernelTransition(tx, {
      entity: 'session',
      to: sessionTarget,
      set: completedSuccess
        ? { failureReason: null, failureDetail: null, updatedAt: now }
        : { failureReason: reason, updatedAt: now },
      where: and(
        inArray(agentSessions.id, abortedSessionIds),
        inArray(agentSessions.status, [...LIVE_SESSION_STATUSES]),
      ),
      fromStatus: 'active',
      reason,
      actor: { type: 'system' },
      source: 'cascade',
    });
  }

  const killableJobs = cancelledJobs.filter((j) => j.deviceId);

  return { cancelledJobIds, abortedSessionIds, deviceBySession, killableJobs };
}

export async function requestKillsForCascade(
  killableJobs: JobRow[],
  reason: CascadeReason,
): Promise<string[]> {
  if (killableJobs.length === 0) return [];
  const { requestJobKill } = await import('../jobs/kill-gate.js');
  const notified = new Set<string>();
  for (const job of killableJobs) {
    try {
      const outcome = await requestJobKill(job, reason);
      if (outcome === 'requested' && job.deviceId) notified.add(job.deviceId);
    } catch (err) {
      logger.error(
        { err, jobId: job.id, deviceId: job.deviceId },
        'cascadeCancelChildJobs: job.cancel kill request failed',
      );
    }
  }
  return Array.from(notified);
}

export function reasonForOutcome(outcome: 'completed' | 'failed' | 'cancelled'): CascadeReason {
  if (outcome === 'completed') return 'pipeline_completed';
  if (outcome === 'failed') return 'pipeline_failed';
  return 'pipeline_cancelled';
}
