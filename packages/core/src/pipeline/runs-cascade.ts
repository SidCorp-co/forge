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
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentSessions, jobs } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { deviceRoom } from '../ws/rooms.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type CascadeReason = 'pipeline_cancelled' | 'pipeline_completed' | 'pipeline_failed';

export interface CascadeResult {
  cancelledJobIds: string[];
  abortedSessionIds: string[];
  /** deviceId keyed by sessionId — used to fan out `agent:abort` to the
   *  exact device room of each in-flight session. */
  deviceBySession: Map<string, string>;
}

/**
 * Mark every still-active child job of `runId` cancelled, mark linked
 * agent_sessions failed, and return the device fan-out map. The caller is
 * responsible for broadcasting `agent:abort` AFTER the transaction commits
 * (so we never publish an event the DB has rolled back). Pass the
 * transaction handle so the cascade rides on the same tx as the run-status
 * UPDATE; if a transaction is not available, pass `db` directly — the
 * cascade is idempotent (status WHERE clause excludes terminal rows).
 *
 * Includes `'running'` jobs deliberately: a closed pipeline_run with a
 * still-running child job is the same orphan class as a still-dispatched
 * one. `cancelPipelineRun` previously cleaned only `queued|dispatched`;
 * unifying here closes that gap.
 */
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
      inArray(jobs.status, ['queued', 'dispatched', 'running']),
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

  return { cancelledJobIds, abortedSessionIds, deviceBySession };
}

/**
 * Fan out `agent:abort` to each affected device room. Defensive: one bad
 * fan-out must not propagate after the DB has committed.
 *
 * `ws/server.js` is lazy-loaded so `pipeline/runs.ts` (imported by
 * lightweight call sites like `skills/crud-routes.ts`) does not pull the
 * full WS / runner / dispatcher graph in at module-init time. The publish
 * path is hit only on actual cascade, so the dynamic import cost is amortised.
 */
export async function broadcastAbortEvents(
  deviceBySession: Map<string, string>,
  reason: CascadeReason,
  runId: string,
): Promise<string[]> {
  if (deviceBySession.size === 0) return [];
  const { roomManager } = await import('../ws/server.js');
  const notified = new Set<string>();
  for (const [sessionId, deviceId] of deviceBySession.entries()) {
    try {
      roomManager.publish(deviceRoom(deviceId), {
        event: 'agent:abort',
        data: { sessionId, reason },
      });
      notified.add(deviceId);
    } catch (err) {
      logger.error(
        { err, runId, sessionId, deviceId },
        'cascadeCancelChildJobs: agent:abort publish failed',
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
