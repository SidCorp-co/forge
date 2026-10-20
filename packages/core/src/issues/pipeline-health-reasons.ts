import { fleetSentence } from '../jobs/capacity-fleet.js';
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

/**
 * The runner-layer (L4/L5) `waitingOn` for a queued candidate, or `null`. Named off the project's
 * online runners as the capacity notice names them (ISS-1228): `runner_stale` only where none is
 * online, `runner_too_old` where every online one is out of date, and `runner_capacity`, with the
 * notice's own sentence and next step, for any other mix — an account limit, a missing workspace.
 */
export function runnerWaitingOn(
  sinceIso: string,
  runnerPool: RunnerAvailability,
): PipelineHealth['waitingOn'] {
  if (runnerPool.total > 0) return undefined;
  const fleet = runnerPool.fleet;
  const said = fleet ? fleetSentence(fleet) : null;
  if (!fleet || !said) {
    return { reason: 'runner_stale', since: sinceIso, details: { freshRunners: 0 } };
  }
  if (fleet.bars.too_old === fleet.online) {
    return { reason: 'runner_too_old', since: sinceIso, details: { online: fleet.online } };
  }
  return {
    reason: 'runner_capacity',
    since: sinceIso,
    details: {
      online: fleet.online,
      bars: said.named,
      summary: said.summary,
      nextStep: said.nextStep,
    },
  };
}
