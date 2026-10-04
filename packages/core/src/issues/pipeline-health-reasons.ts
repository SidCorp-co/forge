import type { PauseResumer } from '../pipeline/run-pause.js';
import type {
  PipelineGate,
  PipelineHealth,
  PipelineHealthJob,
  PipelineHealthQueuedStep,
  PipelineReading,
  PipelineWaitingReason,
} from './pipeline-health-types.js';
import { holdReleasesItself, type RunnerAvailability, readHoldState } from './ports.js';

const GATE_READINGS: Record<Exclude<PipelineWaitingReason, 'job_held'>, PipelineReading> = {
  issue_busy: {
    short: 'Another job active',
    detail: 'Another job is already active on this issue.',
    who: 'Wait for the active run to finish.',
    needsAction: false,
  },
  run_not_running: {
    short: 'Run paused',
    detail:
      'The step is queued, but its pipeline run is paused or already closed — nothing will dispatch it.',
    who: 'Resume the run (or cancel it and re-open the issue for a fresh one).',
    needsAction: true,
  },
  runner_stale: {
    short: 'No runner online',
    detail: 'No runner is online for this project — every host is offline, stale, or rate-limited.',
    who: 'Bring a runner back (check the Runners tab); the step dispatches on the next tick.',
    needsAction: true,
  },
  retry_cooldown: {
    short: 'Retry cooldown',
    detail: 'The step failed and is waiting out a cooldown before its next attempt.',
    who: "No action — the retry fires itself. If the attempts keep failing, read the step's error rather than waiting.",
    needsAction: false,
  },
  runner_too_old: {
    short: 'Runner build too old',
    detail: 'Every online runner for this project is running a build too old to claim work.',
    who: 'Update the runner on that host; the step dispatches on the next tick once it reports the new version.',
    needsAction: true,
  },
};

function heldReading(releasesItself: boolean): PipelineReading {
  return releasesItself
    ? {
        short: 'Step held',
        detail: 'A step is held: it could not run and is waiting for the condition to clear.',
        who: 'No action — it resumes itself, and alerts if the hold outlives the condition.',
        needsAction: false,
      }
    : {
        short: 'Step held',
        detail: 'A step is held: it could not run, and this hold does not clear on its own.',
        who: 'Fix the cause, then cancel the step — the issue can only move on once it is cancelled.',
        needsAction: true,
      };
}

export function gateOf(
  reason: PipelineWaitingReason,
  since: string,
  details: Record<string, unknown>,
): PipelineGate {
  const reading =
    reason === 'job_held' ? heldReading(details.releasesItself === true) : GATE_READINGS[reason];
  return { reason, since, details, reading };
}

const PAUSE_READINGS: Record<PauseResumer, Omit<PipelineReading, 'short'>> = {
  operator: {
    detail:
      "The pipeline run for this issue is paused. No step will dispatch while it is, whatever this issue's status says.",
    who: 'Resume the run — nothing else will. Cancel it instead if the work should not continue.',
    needsAction: true,
  },
  machine: {
    detail:
      'The pipeline run for this issue is paused, waiting for the condition that paused it to clear.',
    who: 'No action — it resumes itself once the condition clears.',
    needsAction: false,
  },
  sweeper: {
    detail:
      'The pipeline run for this issue is paused for a reason this build no longer has code for.',
    who: 'No action — the sweeper frees it on its next tick. Resume it by hand only if it is still paused after that.',
    needsAction: false,
  },
};

/** A paused run as a person reads it: who ends the pause, and what holds it. */
export function pauseReading(p: {
  resumer: PauseResumer;
  kind: string | null;
  detail: string | null;
}): PipelineReading {
  const copy = PAUSE_READINGS[p.resumer];
  const held = p.kind
    ? `${copy.detail} It is held by ${p.kind.replace(/_/g, ' ')}${p.detail ? ` at ${p.detail}` : ''}.`
    : `${copy.detail} An operator paused it.`;
  return { short: 'Run paused', detail: held, who: copy.who, needsAction: copy.needsAction };
}

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
  return gateOf('job_held', held.queuedAt.toISOString(), {
    heldJobId: held.id,
    heldJobType: held.type,
    holdReason: held.failureReason ?? null,
    releasesItself: holdReleasesItself(readHoldState(held.payload), held.failureReason ?? null),
  });
}

/** The `retry_cooldown` waitingOn for a candidate inside the fixed inter-attempt
 *  wait `retry.ts` stamps after a failure, or `null`. */
export function retryCooldownWaitingOn(
  candidate: PipelineHealthJob,
  sinceIso: string,
  now: Date,
): PipelineHealth['waitingOn'] {
  if (!candidate.retryAfterAt || candidate.retryAfterAt <= now) return undefined;
  return gateOf('retry_cooldown', sinceIso, {
    queuedJobId: candidate.id,
    queuedJobType: candidate.type,
    retryAfterAt: candidate.retryAfterAt.toISOString(),
  });
}

/** The runner-layer (L4/L5) `waitingOn` for a queued candidate, or `null`. */
export function runnerWaitingOn(
  sinceIso: string,
  runnerPool: RunnerAvailability,
): PipelineHealth['waitingOn'] {
  if (runnerPool.total === 0) {
    return gateOf('runner_stale', sinceIso, { freshRunners: 0 });
  }

  return undefined;
}
