import { UNHELD_LIVE_JOB_STATUSES } from '../jobs/status-sets.js';
import type { KernelFlip, RunFacts, StandingContext } from './standing-types.js';

export const NOW = new Date('2026-10-04T10:00:00Z');
export const at = (min: number) => new Date(NOW.getTime() + min * 60_000);

export const ctx = (over: Partial<StandingContext> = {}): StandingContext => ({
  now: NOW,
  viewer: { canWrite: true, isAdmin: false },
  slots: { inUse: 1, max: 3 },
  stuckAfterMs: 3 * 60_000,
  silenceReapMs: 10 * 60_000,
  jobHeartbeatMs: 3 * 60_000,
  jobAckMs: 2 * 60_000,
  killGraceMs: 90_000,
  ...over,
});

export const session = (
  over: Partial<NonNullable<RunFacts['session']>> = {},
): RunFacts['session'] => ({
  id: 's-1',
  status: 'running',
  runtimeState: null,
  failureReason: null,
  failureDetail: null,
  lastHeartbeatAt: at(-1),
  startedAt: at(-30),
  createdAt: at(-30),
  updatedAt: at(-1),
  device: { id: 'd-1', name: 'box-1' },
  name: 'ISS-7',
  ...over,
});

export const job = (over: Partial<NonNullable<RunFacts['job']>> = {}): RunFacts['job'] => ({
  id: 'j-1',
  type: 'code',
  status: 'running',
  heldBy: null,
  heldAt: null,
  hold: null,
  retryAfterAt: null,
  failureReason: null,
  queuedAt: at(-20),
  dispatchedAt: at(-19),
  ackedAt: at(-18),
  finishedAt: null,
  device: { id: 'd-1', name: 'box-1' },
  agentSessionId: 'js-1',
  sessionBeat: at(-1),
  sessionFailureReason: null,
  sessionFailureDetail: null,
  sessionStatus: 'running',
  sessionRuntimeState: null,
  sessionStartedAt: at(-18),
  sessionUpdatedAt: at(-1),
  sessionCreatedAt: at(-19),
  sessionHeartbeatReaped: true,
  hasEvents: true,
  ...over,
});

export const flip = (over: Partial<KernelFlip> = {}): KernelFlip => ({
  toStatus: 'completed',
  reason: null,
  actorType: 'system',
  agency: 'agent',
  userId: null,
  name: null,
  at: at(-2),
  ...over,
});

export function facts(over: Partial<RunFacts> = {}, run: Partial<RunFacts['run']> = {}): RunFacts {
  return {
    run: {
      id: 'r-1',
      projectId: 'p-1',
      rawLane: 'run_session',
      status: 'running',
      startedAt: at(-30),
      finishedAt: null,
      updatedAt: at(-30),
      currentStep: null,
      openPhase: undefined,
      pauseReason: null,
      releaseVersion: null,
      ...run,
    },
    issue: {
      id: 'i-7',
      key: 'ISS-7',
      title: 'Seven',
      status: 'in_progress',
      statusSince: at(-40),
      strand: null,
    },
    issues: ['ISS-7'],
    openingStatuses: { 'ISS-7': 'open' },
    endStatuses: { 'ISS-7': 'in_progress' },
    workState: { step: 'build', stepStartedAt: at(-10), lease: null },
    session: session(),
    job: null,
    liveJobs: 0,
    lastBeatAt: at(-1),
    ledger: null,
    fleetKeys: [{ issueKey: 'ISS-7', sessionId: 's-1', acquiredAt: at(-30) }],
    deployLocks: [],
    question: null,
    approval: null,
    releaseAttempt: null,
    runFlip: null,
    sessionFlip: null,
    master: { sessionId: 'm-1', name: 'master-forge', live: true, lastBeatAt: at(-1) },
    pass: null,
    attempt: { n: 2, retryOf: 'r-0', of: 'ISS-7' },
    ...over,
  };
}

export const jobLane = (j: RunFacts['job'], run: Partial<RunFacts['run']> = {}) =>
  facts(
    {
      session: null,
      job: j,
      fleetKeys: [],
      liveJobs: j && (UNHELD_LIVE_JOB_STATUSES as readonly string[]).includes(j.status) ? 1 : 0,
    },
    { rawLane: 'job', ...run },
  );
