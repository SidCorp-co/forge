// where a run stands, derived from what `runs/facts.ts` read and nothing else (design agent-run-standing
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
import { type Said, say, sayEn, verbatim } from '@forge/contracts/said';
import { stepOf } from '../pipeline/index.js';
import { finalOf } from './standing-final.js';
import { holderOf } from './standing-holder.js';
import { liveOf, masterWho } from './standing-live.js';
import { type StuckReading, stuckField, stuckOf } from './standing-stuck.js';
import {
  type Derived,
  iso,
  isReleaseRun,
  none,
  type RunFacts,
  type RunWaitingOn,
  runWait,
  type StandingContext,
} from './standing-types.js';

export type { KernelFlip, RunFacts, StandingContext } from './standing-types.js';

const noStep = (detail: Said): RunStep => ({
  source: 'none',
  step: null,
  detail: sayEn(detail),
  says: { detail },
});

function stepFor(f: RunFacts, live: boolean): RunStep {
  const stepAt = f.workState?.stepStartedAt ?? null;
  if (live && f.workState?.step && stepAt && stepAt.getTime() < f.run.startedAt.getTime()) {
    return noStep(
      say('runs.step.earlier', {
        step: f.workState.step,
        since: stepAt.toISOString(),
        started: f.run.startedAt.toISOString(),
      }),
    );
  }
  if (live && f.workState?.step) {
    return { source: 'work_state', step: f.workState.step, since: iso(stepAt) };
  }
  const read = stepOf(f.run.rawLane, f.run.currentStep, f.run.openPhase);
  if (read.source === 'none') {
    return noStep(
      live ? read.says.detail : say('runs.step.finished', { detail: read.says.detail }),
    );
  }
  return { source: read.source, step: read.step, since: null };
}

function laneOfRun(f: Pick<RunFacts, 'run' | 'issue' | 'job' | 'deployLocks'>): RunLane {
  if (isReleaseRun(f)) return 'release';
  if (f.issue || f.run.rawLane === 'run_session') return 'issue';
  if (f.deployLocks.length > 0) return 'deploy';
  return 'job';
}

function titleOf(f: RunFacts, lane: RunLane): Said {
  if (f.issue) return verbatim(f.issue.title);
  if (lane === 'release') {
    return f.run.releaseVersion
      ? say('runs.title.release', { v: f.run.releaseVersion })
      : say('runs.title.releaseBatch');
  }
  const lock = f.deployLocks[0];
  if (lock) return say('runs.title.deploy', { subject: lock.subject, environment: lock.environment });
  if (f.session?.name) return verbatim(f.session.name);
  if (f.job) return say('runs.holder.job', { type: f.job.type });
  return say('runs.title.run');
}

function attemptOf(f: RunFacts): RunAttempt {
  if (!f.attempt)
    return none(say('runs.attempt.noIssue'));
  return { source: 'runs', n: f.attempt.n, retryOf: f.attempt.retryOf, of: f.attempt.of };
}

function masterOf(f: RunFacts): RunMasterRef {
  if (!f.master)
    return none(say('runs.master.none'));
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
      masterWho(f),
      say('runs.act.actsNext'),
      say('runs.rule.stuck', {
        rule: reading.rule,
        ended: base.outcome ? say('runs.rule.rootEnded', { rule: base.rule }) : null,
      }),
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
  const act = step.step
    ? say('issues.standing.act.step', { step: step.step })
    : say('issues.standing.act.working');
  return runWait('run', holder.says.name, act, derived.waitingOn.says.rule, {
    dueAt: holder.expiresAt,
  });
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
  const title = titleOf(f, lane);
  return {
    id: f.run.id,
    projectId: f.run.projectId,
    lane,
    state: derived.state,
    since: iso(derived.since),
    rule: sayEn(derived.rule),
    title: sayEn(title),
    says: { rule: derived.rule, title },
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
