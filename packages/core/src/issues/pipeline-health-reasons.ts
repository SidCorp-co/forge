/**
 * ISS-164 — the per-gate `waitingOn` builders for `pipeline-health.ts`.
 *
 * Each function answers ONE arm of the dispatch CASE in
 * `jobs/dispatch-gates.ts#buildGateReasonCase`. They live apart from the
 * classifier because the classifier owns only the PRECEDENCE between arms;
 * what each arm reports, and the incident each shape came from, belongs
 * beside the arm itself. Pure: no db, and any clock is injected.
 */

import type { JobType } from '../db/schema.js';
import type { RunnerAvailability } from '../jobs/dispatch-gates.js';
import { runnerSupportsJobType } from '../jobs/dispatch-gates.js';
import { TRIGGER_STATUS_BY_JOB_TYPE, WORKING_STATUS_BY_JOB_TYPE } from '../pipeline/registry.js';
import type {
  PipelineHealth,
  PipelineHealthJob,
  PipelineHealthQueuedStep,
  PipelineHealthRunnerSat,
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

/** The `stale_trigger` waitingOn for a queued candidate answering a trigger the
 *  issue has already left, or `null`. */
// cm:guard every clause here mirrors one in `predicates.staleTrigger`, and the two must agree on EVERY input — this arm claims the step is about to be discarded, so a clause here the gate lacks promises a discard that never comes, and one the gate has and this lacks hides a discard that does. The cooldown is NOT among them: the gate resolves it in an earlier CASE arm, so the classifier's caller must reach `retryCooldownWaitingOn` first, in that same order.
// cm:edge lockstep -> packages/core/src/jobs/dispatch-gates.ts — `predicates.staleTrigger` is the authority for both the job-type scope (which keeps `drive` out) and the per-type `workingStatus` allowance
export function staleTriggerWaitingOn(
  candidate: PipelineHealthJob,
  liveStatus: string,
  sinceIso: string,
): PipelineHealth['waitingOn'] {
  const declared = candidate.stageStatus;
  if (!declared || declared === liveStatus) return undefined;
  if (!TRIGGER_STATUS_BY_JOB_TYPE[candidate.type as JobType]) return undefined;
  if (WORKING_STATUS_BY_JOB_TYPE[candidate.type as JobType] === liveStatus) return undefined;
  return {
    reason: 'stale_trigger',
    since: sinceIso,
    details: {
      queuedJobId: candidate.id,
      queuedJobType: candidate.type,
      declaredTrigger: declared,
      liveStatus,
    },
  };
}

/** The runner-layer (L4/L5) `waitingOn` for a queued candidate, or `null`. */
// cm:guard report the EMPTY pool before a saturated one — "no runner is online" and "every runner is busy" read almost identically in the UI but need opposite actions (bring a host back vs. wait), and the empty-pool arm is the one that was missing while 11 jobs sat behind dead runners for up to 22 days
export function runnerWaitingOn(
  candidate: PipelineHealthJob,
  sinceIso: string,
  runnerInFlight: ReadonlyMap<string, PipelineHealthRunnerSat>,
  runnerPool: RunnerAvailability,
): PipelineHealth['waitingOn'] {
  if (runnerPool.total === 0) {
    return { reason: 'runner_stale', since: sinceIso, details: { freshRunners: 0 } };
  }

  const sat = candidate.runnerId ? runnerInFlight.get(candidate.runnerId) : undefined;
  if (
    candidate.runnerId &&
    sat &&
    sat.inFlight >= sat.cap &&
    runnerSupportsJobType(
      sat.type as Parameters<typeof runnerSupportsJobType>[0],
      candidate.type as Parameters<typeof runnerSupportsJobType>[1],
    )
  ) {
    return {
      reason: 'runner_full',
      since: sinceIso,
      details: { runnerId: candidate.runnerId, cap: sat.cap, inFlight: sat.inFlight },
    };
  }

  // cm:why the pinned-runner branch above only covers a candidate that ALREADY has a runner_id; an unpinned job whose whole pool is busy fails the picker's pool-coarse EXISTS with nothing said about it here
  if (runnerPool.withCapacity === 0) {
    return {
      reason: 'runner_full',
      since: sinceIso,
      details: { freshRunners: runnerPool.total, runnersWithCapacity: 0 },
    };
  }

  return undefined;
}
