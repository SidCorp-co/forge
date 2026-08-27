/**
 * ISS-258 — shared cascade helper for `pipeline_runs` terminal transitions.
 *
 * Whenever a run flips to a terminal status (`completed | failed | cancelled`)
 * any child `jobs` rows still in `queued | dispatched | running` are orphaned:
 * the dispatcher gate counts them against the runner's inFlight cap forever
 * and no later lifecycle event will resolve them. The cancel path in
 * `runs-control.ts` already had this cleanup; the natural-close paths in
 * `runs.ts` (`closeRun`, `closeRunIfOneShot`, `closeOpenRunForIssue`) did not,
 * so an issue closing while a triage job sat in `dispatched` wedged the
 * runner indefinitely (the production stall on 2026-05-27).
 *
 * This module is the single SSOT for the cascade so MCP cancel and natural
 * close cannot drift.
 *
 * ISS-785 — `agent:abort` (keyed by `agent_sessions.id`) was always a no-op
 * for pipeline jobs (keyed by `jobId`); `requestKillsForCascade` fixes that
 * with the real primitive, `job.cancel` (see `jobs/kill-gate.ts`).
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentSessions, jobs } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type JobRow = typeof jobs.$inferSelect;

export type CascadeReason = 'pipeline_cancelled' | 'pipeline_completed' | 'pipeline_failed';

export interface CascadeResult {
  cancelledJobIds: string[];
  abortedSessionIds: string[];
  /** deviceId keyed by sessionId — kept for the existing MCP cancel response
   *  shape (`deviceIdsNotified`); no longer used to pick an event to send. */
  deviceBySession: Map<string, string>;
  /** ISS-785 — the terminal-flipped job rows that have a device to kill on.
   *  Pass to `requestKillsForCascade` AFTER the transaction commits (same
   *  "never publish/act on a rolled-back write" contract the old
   *  `agent:abort` fan-out had). */
  killableJobs: JobRow[];
}

/**
 * Mark every still-active child job of `runId` cancelled, mark linked
 * agent_sessions failed, and return the device fan-out map plus the job rows
 * to kill. The caller is responsible for calling `requestKillsForCascade`
 * AFTER the transaction commits (so we never act on a write the DB has
 * rolled back). Pass the transaction handle so the cascade rides on the same
 * tx as the run-status UPDATE; if a transaction is not available, pass `db`
 * directly — the cascade is idempotent (status WHERE clause excludes
 * terminal rows).
 *
 * Includes `'running'` jobs deliberately: a closed pipeline_run with a
 * still-running child job is the same orphan class as a still-dispatched
 * one. `cancelPipelineRun` previously cleaned only `queued|dispatched`;
 * unifying here closes that gap.
 */
// cm:flow release/reap after:close — closing the run reaps its child jobs, and on a `pipeline_completed` close the release job that is still running flips to done, NOT cancelled; that sentinel is why a successful release does not look like a cancelled one
// cm:guard every terminal pipeline_runs.status transition must route through this helper — nothing else reaps child jobs
// cm:edge lockstep -> packages/core/src/jobs/loop-monitor.ts — orphan-hygiene defence 2; the three defences move together
// cm:edge lockstep -> packages/core/src/jobs/dispatch-gates.ts — orphan-hygiene defence 3
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
    where: and(
      eq(jobs.pipelineRunId, runId),
      inArray(jobs.status, ['queued', 'dispatched', 'running', 'held']),
    ),
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

  // cm:edge sideeffect -> packages/core/src/skills/reconcile-service.ts — a reconcile/verify_skill job cancelled here never routes through finalizeFailedJob, so it still needs the same terminal path (BLOCKER M path 3, ISS-801 review); only the genuine-cancel branch, since a `pipeline_completed` close flips these to 'done' instead.
  // cm:why dynamic import avoids a runs-cascade -> reconcile-service -> pipeline/runs -> runs-cascade cycle (reconcile-service imports closeRun/openOneShotRun from pipeline/runs.js, which imports this module).
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
        ? { failureReason: null, updatedAt: now }
        : { failureReason: reason, updatedAt: now },
      where: and(
        inArray(agentSessions.id, abortedSessionIds),
        inArray(agentSessions.status, ['queued', 'running', 'idle']),
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

/**
 * ISS-785 — request+broadcast a real `job.cancel` for each cascaded job that
 * has a device to kill on, via the SSOT in `jobs/kill-gate.ts`. Call AFTER
 * the transaction commits — same "never act on a rolled-back write" contract
 * the `agent:abort` fan-out this replaces had. Defensive: one bad request
 * must not stop the rest.
 *
 * `jobs/kill-gate.js` is lazy-loaded (mirrors the old `agent:abort` fan-out's
 * lazy `ws/server.js` import) — it pulls in `ws/server.js` (the full WS /
 * runner / dispatcher graph), which lightweight callers of this module
 * (`pipeline/runs.ts` → `skills/crud-routes.ts`, etc.) must not pay for at
 * module-init time just because a cascade happened to run.
 */
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
