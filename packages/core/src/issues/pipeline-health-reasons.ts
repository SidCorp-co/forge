/**
 * ISS-164 — the per-gate `waitingOn` builders for `pipeline-health.ts`.
 *
 * Each function answers ONE arm of the dispatch CASE in
 * `jobs/queued-gates.ts#buildGateReasonCase`. They live apart from the
 * classifier because the classifier owns only the PRECEDENCE between arms;
 * what each arm reports, and the incident each shape came from, belongs
 * beside the arm itself. Pure: no db, and any clock is injected.
 */

import type { RunnerAvailability } from '../jobs/queued-gates.js';
import type {
  PipelineHealth,
  PipelineHealthJob,
  PipelineHealthQueuedStep,
} from './pipeline-health-types.js';

/** ISS-903 — the queued candidate as a human surface reads it. Unconditional:
 *  every queued job has a step identity, whether or not a gate is holding it. */
export function queuedStepOf(candidate: PipelineHealthJob): PipelineHealthQueuedStep {
  return {
    jobId: candidate.id,
    jobType: candidate.type,
    stageStatus: candidate.stageStatus ?? null,
    queuedAt: candidate.queuedAt.toISOString(),
    retryAfterAt: candidate.retryAfterAt?.toISOString() ?? null,
  };
}

/** The `job_held` waitingOn for an issue with a held job, or `null`. */
export function heldWaitingOn(issueJobs: PipelineHealthJob[]): PipelineHealth['waitingOn'] {
  const held = issueJobs.find((j) => j.status === 'held');
  if (!held) return undefined;
  return {
    reason: 'job_held',
    since: held.queuedAt.toISOString(),
    details: {
      heldJobId: held.id,
      heldJobType: held.type,
      holdReason: held.failureReason ?? null,
    },
  };
}

/** The `retry_cooldown` waitingOn for a candidate inside the fixed inter-attempt
 *  wait `retry.ts` stamps after a failure, or `null`. */
// cm:guard this arm is what keeps the cooldown honest, and it predates nothing — for every cooldown-gated job on `main` this classifier reported NO waitingOn at all, i.e. exactly the idle-and-actionable render the file's own guard forbids, because `retry_cooldown` had no member in `PipelineWaitingReason` while `buildGateReasonCase` has returned it since ISS-197
export function retryCooldownWaitingOn(
  candidate: PipelineHealthJob,
  sinceIso: string,
  now: Date,
): PipelineHealth['waitingOn'] {
  if (!candidate.retryAfterAt || candidate.retryAfterAt <= now) return undefined;
  return {
    reason: 'retry_cooldown',
    since: sinceIso,
    details: {
      queuedJobId: candidate.id,
      queuedJobType: candidate.type,
      retryAfterAt: candidate.retryAfterAt.toISOString(),
    },
  };
}

/** The runner-layer (L4/L5) `waitingOn` for a queued candidate, or `null`. */
// cm:guard report the EMPTY pool before a saturated one — "no runner is online" and "every runner is busy" read almost identically in the UI but need opposite actions (bring a host back vs. wait), and the empty-pool arm is the one that was missing while 11 jobs sat behind dead runners for up to 22 days
export function runnerWaitingOn(
  sinceIso: string,
  runnerPool: RunnerAvailability,
): PipelineHealth['waitingOn'] {
  if (runnerPool.total === 0) {
    return { reason: 'runner_stale', since: sinceIso, details: { freshRunners: 0 } };
  }

  return undefined;
}
