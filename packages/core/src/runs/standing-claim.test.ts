import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { runStandingOf as runStandingOf_ } from './standing.js';
import type { RunFacts, StandingContext } from './standing-types.js';

/** Every sentence the producer said agrees with the English beside it (`saidDisagreements`). */
const checked = <T>(v: T): T => {
  expect(saidDisagreements(v)).toEqual([]);
  return v;
};
const runStandingOf = ((...a: Parameters<typeof runStandingOf_>) => checked(runStandingOf_(...a))) as typeof runStandingOf_;


// epod 2026-10-06: the master claimed ISS-1 from its own checkout, a builder run declared over ISS-1
// in .claude/worktrees/ISS-1 and committed there, and runs/standing served the run stuck because the
// master's claim lapsed. A claim taken from another checkout is not this run's claim.

const now = new Date('2026-10-06T01:26:00Z');
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);
const CHECKOUT = '/home/dev/projects/epodsystem-core';
const WORKTREE = `${CHECKOUT}/.claude/worktrees/ISS-1`;

const ctx = {
  now,
  viewer: null,
  slots: null,
  queuedGates: new Map(),
  stuckAfterMs: 3 * 60_000,
  silenceReapMs: 10 * 60_000,
} as unknown as StandingContext;

function building(
  lease: Record<string, unknown>,
  worktreePath: string | null = WORKTREE,
): RunFacts {
  return {
    run: {
      id: 'run-iss-1',
      projectId: 'p',
      rawLane: 'run_session',
      status: 'running',
      startedAt: minutes(-14),
      finishedAt: null,
      updatedAt: minutes(-14),
      currentStep: null,
      openPhase: undefined,
      pauseReason: null,
      releaseVersion: null,
      declarationRefusal: null,
    },
    issue: {
      id: 'i1',
      key: 'ISS-1',
      title: 'Contract 1.1.0',
      status: 'open',
      statusSince: null,
      strand: null,
    },
    issues: ['ISS-1'],
    openingStatuses: { 'ISS-1': 'open' },
    endStatuses: {},
    workState: { step: null, stepStartedAt: null, lease },
    session: {
      id: 'sess-run',
      status: 'running',
      runtimeState: null,
      failureReason: null,
      failureDetail: null,
      lastHeartbeatAt: minutes(-1),
      startedAt: minutes(-14),
      createdAt: minutes(-14),
      updatedAt: minutes(-1),
      device: { id: 'd', name: 'box' },
      name: 'ISS-1',
    },
    job: null,
    liveJobs: 0,
    lastBeatAt: minutes(-1),
    ledger:
      worktreePath === null
        ? null
        : {
            incarnation: 'live',
            work: 'runnable',
            blockerKind: null,
            waitingOn: null,
            observedAt: minutes(-1),
            worktreePath,
          },
    fleetKeys: [{ issueKey: 'ISS-1', sessionId: 'sess-run', acquiredAt: minutes(-14) }],
    deployLocks: [],
    lockRefusals: [],
    question: null,
    approval: null,
    releaseAttempt: null,
    runFlip: null,
    sessionFlip: null,
    master: null,
    pass: null,
    attempt: null,
  } as unknown as RunFacts;
}

const lapsed = (tree?: string) => ({
  holder: 'f623210e-master',
  renewedAt: minutes(-15).toISOString(),
  minutes: 10,
  ...(tree === undefined ? {} : { tree }),
});

describe('agent-run-standing stuck: a lapsed claim is the run’s only when the run holds it', () => {
  it('serves a live, beating run as running when the lapsed claim was taken from another checkout', () => {
    const s = runStandingOf(building(lapsed(CHECKOUT)), ctx);
    expect(s.state).toBe('running');
    expect(s.stuck.source).toBe('clear');
    expect(s.holder.source === 'held' && s.holder.expiries.map((e) => e.source)).toEqual([
      'silence_reap',
    ]);
  });

  it('still serves lease_expired when the lapsed claim was taken in the run’s own worktree', () => {
    const s = runStandingOf(building(lapsed(`${WORKTREE}/`)), ctx);
    expect(s.state).toBe('stuck');
    expect(s.stuck).toMatchObject({ source: 'stuck', rule: 'lease_expired' });
  });

  it('still serves lease_expired when the claim names no tree, so it cannot be told apart', () => {
    expect(runStandingOf(building(lapsed()), ctx).stuck).toMatchObject({ rule: 'lease_expired' });
  });

  it('still serves lease_expired when the box reported no worktree for the run', () => {
    expect(runStandingOf(building(lapsed(CHECKOUT), null), ctx).stuck).toMatchObject({
      rule: 'lease_expired',
    });
  });
});
