// cm:why where a run stands, derived from what `runs/facts.ts` read and nothing else (design agent-run-standing
// rev 1, ISS-108; stuck ISS-109): pure, so every rule is a unit test, and the screen never derives a state of its own

import type {
  RunAttempt,
  RunGroup,
  RunHolder,
  RunLane,
  RunMasterRef,
  RunRelease,
  RunStanding,
  RunState,
  RunStep,
} from '@forge/contracts/run-standing';
import { stepOf } from '../pipeline/index.js';
import { finalOf } from './standing-final.js';
import { holderOf } from './standing-holder.js';
import { liveOf } from './standing-live.js';
import { type StuckReading, stuckField, stuckOf } from './standing-stuck.js';
import {
  type Derived,
  iso,
  none,
  type RunFacts,
  type RunWaitingOn,
  runWait,
  type StandingContext,
} from './standing-types.js';

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

function laneOfRun(f: Pick<RunFacts, 'run' | 'issue' | 'job' | 'deployLocks'>): RunLane {
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

function asStuck(f: RunFacts, base: Derived, reading: StuckReading): Derived {
  return {
    state: 'stuck',
    since: reading.since,
    rule: reading.detail,
    outcome: null,
    waitingOn: runWait(
      'master',
      f.master?.name ?? 'Master',
      'acts next',
      `stuck (${reading.rule}): the project master acts next, and a person may cancel the run or revoke its lease${
        base.outcome ? `; its root already ended: ${base.rule}` : ''
      }`,
    ),
  };
}

const GROUP_OF: Record<RunState, RunGroup> = {
  queued: 'queued',
  claimed: 'running',
  running: 'running',
  waiting_person: 'waiting',
  waiting_gate: 'waiting_gate',
  stuck: 'stuck',
  done: 'finished',
  failed: 'finished',
  cancelled: 'finished',
  handed_back: 'finished',
};

const runGroupOf = (state: RunState, waitingOn: RunWaitingOn): RunGroup =>
  waitingOn.kind === 'you' ? 'needs_you' : GROUP_OF[state];

// A live run nobody waits on names its holder at work, with the lease's end as the deadline.
function atWork(derived: Derived, holder: RunHolder, step: RunStep): RunWaitingOn {
  if (derived.waitingOn.kind !== 'none' || derived.outcome !== null || holder.source !== 'held')
    return derived.waitingOn;
  const word = step.step ? `${step.step.charAt(0).toUpperCase()}${step.step.slice(1)}` : 'working';
  return runWait('run', holder.name, word, derived.waitingOn.rule, { dueAt: holder.expiresAt });
}

function rootSessionOf(f: RunFacts): string | null {
  return f.session?.id ?? f.job?.agentSessionId ?? null;
}

export function runStandingOf(f: RunFacts, ctx: StandingContext): RunStanding {
  const base = finalOf(f) ?? liveOf(f, ctx);
  const reading = stuckOf(f, ctx, base);
  const derived = reading ? asStuck(f, base, reading) : base;
  const lane = laneOfRun(f);
  const live = derived.outcome === null;
  const holder = holderOf(f, ctx, derived.state);
  const step = stepFor(f, live);
  const waitingOn = atWork(derived, holder, step);
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
    sessionId: rootSessionOf(f),
    step,
    attempt: attemptOf(f),
    lastBeatAt: iso(f.lastBeatAt),
    liveJobs: f.liveJobs,
    device: f.session?.device ?? f.job?.device ?? null,
    holder,
    waitingOn,
    attentionGroup: runGroupOf(derived.state, waitingOn),
    outcome: derived.outcome,
    master: masterOf(f),
    stuck: stuckField(reading, derived, holder, ctx),
    release: releaseOf(f, lane),
    deployLocks: f.deployLocks.map((l) => ({
      environment: l.environment,
      subject: l.subject,
      acquiredAt: l.acquiredAt.toISOString(),
      expiresAt: l.expiresAt.toISOString(),
      reclaimedFromRunId: l.reclaimedFromRunId,
    })),
    pipelineStatus: f.run.status,
    job: f.job ? { id: f.job.id, type: f.job.type, status: f.job.status } : null,
    startedAt: f.run.startedAt.toISOString(),
    finishedAt: iso(f.run.finishedAt),
  };
}
