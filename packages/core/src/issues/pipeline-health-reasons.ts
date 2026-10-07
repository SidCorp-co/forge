import { holdReleasesItself, readHoldState } from '@forge/contracts/jobs';
import type { PauseResumer } from '@forge/contracts/run-standing';
import { say, sayEn } from '@forge/contracts/said';
import type {
  PipelineGate,
  PipelineHealth,
  PipelineHealthJob,
  PipelineHealthQueuedStep,
  PipelineReading,
  PipelineWaitingReason,
} from './pipeline-health-types.js';
import type { RunnerAvailability } from './ports.js';

type GateKey =
  | Exclude<PipelineWaitingReason, 'job_held'>
  | 'job_held_clears'
  | 'job_held_stays';

const SHORT: Record<GateKey, string> = {
  issue_busy: 'Another job active',
  run_not_running: 'Run paused',
  runner_stale: 'No runner online',
  retry_cooldown: 'Retry cooldown',
  runner_too_old: 'Runner build too old',
  job_held_clears: 'Step held',
  job_held_stays: 'Step held',
};

const SELF_CLEARING: ReadonlySet<GateKey> = new Set([
  'issue_busy',
  'retry_cooldown',
  'job_held_clears',
]);

/** A gate's reading, its sentences said under `issues.gate.<gate>`. */
function gateReading(gate: GateKey): PipelineReading {
  const says = {
    detail: say(`issues.gate.${gate}.detail`),
    who: say(`issues.gate.${gate}.who`),
  };
  return {
    short: SHORT[gate],
    detail: sayEn(says.detail),
    who: sayEn(says.who),
    needsAction: !SELF_CLEARING.has(gate),
    says,
  };
}

export function gateOf(
  reason: PipelineWaitingReason,
  since: string,
  details: Record<string, unknown>,
): PipelineGate {
  const reading = gateReading(
    reason === 'job_held'
      ? details.releasesItself === true
        ? 'job_held_clears'
        : 'job_held_stays'
      : reason,
  );
  return { reason, since, details, reading };
}

const PAUSE_NEEDS_ACTION: Record<PauseResumer, boolean> = {
  operator: true,
  machine: false,
  sweeper: false,
};

/** A paused run as a person reads it: who ends the pause, and what holds it. */
export function pauseReading(p: {
  resumer: PauseResumer;
  kind: string | null;
  detail: string | null;
}): PipelineReading {
  const base = say(`issues.pause.${p.resumer}.detail`);
  const says = {
    detail: p.kind
      ? say('issues.pause.heldBy', {
          base,
          kind: p.kind.replace(/_/g, ' '),
          at: p.detail ? say('issues.pause.at', { at: p.detail }) : null,
        })
      : say('issues.pause.byOperator', { base }),
    who: say(`issues.pause.${p.resumer}.who`),
  };
  return {
    short: 'Run paused',
    detail: sayEn(says.detail),
    who: sayEn(says.who),
    needsAction: PAUSE_NEEDS_ACTION[p.resumer],
    says,
  };
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
