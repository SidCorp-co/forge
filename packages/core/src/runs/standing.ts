// cm:why where a run stands, derived from what `runs/facts.ts` read and nothing else (design agent-run-standing
// rev 1, ISS-108): pure, so every rule is a unit test, and the screen never derives a state of its own

import type {
  RunAttempt,
  RunLane,
  RunMasterRef,
  RunRelease,
  RunStanding,
  RunStep,
} from '@forge/contracts/run-standing';
import { stepOf } from '../pipeline/runs-lane.js';
import { finalOf } from './standing-final.js';
import { holderOf } from './standing-holder.js';
import { liveOf } from './standing-live.js';
import { iso, none, type RunFacts, type StandingContext } from './standing-types.js';

export type { KernelFlip, RunFacts, StandingContext } from './standing-types.js';

function stepFor(f: RunFacts, live: boolean): RunStep {
  if (live && f.workState?.step) {
    return { source: 'work_state', step: f.workState.step, since: iso(f.workState.stepStartedAt) };
  }
  const read = stepOf(f.run.rawLane, f.run.currentStep, f.run.openPhase);
  if (read.source === 'none') {
    return {
      source: 'none',
      step: null,
      detail: live
        ? read.detail
        : `${read.detail}; a finished run keeps no step of its own, as issue_work_state.step belongs to whichever run holds the issue now`,
    };
  }
  return { source: read.source, step: read.step, since: null };
}

export function laneOfRun(f: Pick<RunFacts, 'run' | 'issue' | 'job' | 'deployLocks'>): RunLane {
  if (f.run.releaseVersion !== null || f.job?.type === 'release_batch') return 'release';
  if (f.issue || f.run.rawLane === 'run_session') return 'issue';
  if (f.deployLocks.length > 0) return 'deploy';
  return 'job';
}

function titleOf(f: RunFacts, lane: RunLane): string {
  if (f.issue) return f.issue.title;
  if (lane === 'release') return `Release ${f.run.releaseVersion ?? 'batch'}`;
  if (f.deployLocks[0])
    return `Deploy ${f.deployLocks[0].subject} to ${f.deployLocks[0].environment}`;
  if (f.session?.name) return f.session.name;
  if (f.job) return `${f.job.type} job`;
  return 'Run';
}

function attemptOf(f: RunFacts): RunAttempt {
  if (!f.attempt)
    return none('this run carries no issue, so no earlier run over the same work is counted');
  return { source: 'runs', n: f.attempt.n, retryOf: f.attempt.retryOf, of: f.attempt.of };
}

function masterOf(f: RunFacts): RunMasterRef {
  if (!f.master)
    return none('no master owns this run: no parent master session and no master hold');
  return {
    source: 'session',
    sessionId: f.master.sessionId,
    name: f.master.name,
    live: f.master.live,
  };
}

function releaseOf(f: RunFacts, lane: RunLane): RunRelease | null {
  if (lane !== 'release') return null;
  return {
    version: f.run.releaseVersion,
    stage: f.releaseAttempt?.stage ?? null,
    verdict: f.releaseAttempt?.verdict ?? null,
    attemptAt: iso(f.releaseAttempt?.startedAt),
  };
}

export const STUCK_NOT_COMPUTED =
  'stuck is not computed in core yet (ISS-109); this read model makes no stuck claim either way';

export function runStandingOf(f: RunFacts, ctx: StandingContext): RunStanding {
  const derived = finalOf(f) ?? liveOf(f, ctx);
  const lane = laneOfRun(f);
  const live = derived.outcome === null;
  return {
    id: f.run.id,
    projectId: f.run.projectId,
    lane,
    state: derived.state,
    since: iso(derived.since),
    rule: derived.rule,
    title: titleOf(f, lane),
    issue: f.issue ? { key: f.issue.key, title: f.issue.title, status: f.issue.status } : null,
    issues: f.issues,
    step: stepFor(f, live),
    attempt: attemptOf(f),
    lastBeatAt: iso(f.lastBeatAt),
    liveJobs: f.liveJobs,
    device: f.session?.device ?? f.job?.device ?? null,
    holder: holderOf(f, ctx, derived.state),
    waitingOn: derived.waitingOn,
    needsViewer: derived.waitingOn.kind === 'person' && derived.waitingOn.isViewer,
    outcome: derived.outcome,
    master: masterOf(f),
    stuck: { source: 'not_computed', detail: STUCK_NOT_COMPUTED },
    release: releaseOf(f, lane),
    deployLocks: f.deployLocks.map((l) => ({
      environment: l.environment,
      subject: l.subject,
      acquiredAt: l.acquiredAt.toISOString(),
      expiresAt: l.expiresAt.toISOString(),
      reclaimedFromRunId: l.reclaimedFromRunId,
    })),
    pipelineStatus: f.run.status,
    startedAt: f.run.startedAt.toISOString(),
    finishedAt: iso(f.run.finishedAt),
  };
}
