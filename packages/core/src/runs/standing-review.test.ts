import type { RunHolder } from '@forge/contracts/run-standing';
import { describe, expect, it } from 'vitest';
import { holderOf } from './standing-holder.js';
import { stuckOf } from './standing-stuck.js';
import type { Derived, RunFacts, StandingContext } from './standing-types.js';

// forge-core-61, 2026-10-30: a review run a person declares (`devices/review-run.ts`) has no process
// on its box to beat it. Its standing names the end its declaration set as its clock, and reads no
// silence as stuck before that end; past it, with the reaper not yet run, it reads stuck as any run
// nothing moves.

const now = new Date('2026-10-30T12:00:00Z');
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

const ctx = {
  now,
  viewer: null,
  slots: null,
  queuedGates: new Map(),
  stuckAfterMs: 3 * 60_000,
  silenceReapMs: 10 * 60_000,
} as unknown as StandingContext;

function reviewRun(expiresAt: Date | null): RunFacts {
  return {
    run: {
      id: 'run-review',
      rawLane: 'run_session',
      status: 'running',
      startedAt: minutes(-20),
      updatedAt: minutes(-20),
      pauseReason: null,
      releaseVersion: null,
      declarationRefusal: null,
      review: expiresAt ? { declaredBy: 'person-1', profile: 'dev', expiresAt } : null,
    },
    issue: null,
    issues: ['ISS-7'],
    statuses: {},
    session: {
      id: 'session-review',
      status: 'running',
      runtimeState: null,
      lastHeartbeatAt: minutes(-20),
      startedAt: minutes(-20),
      createdAt: minutes(-20),
      device: { id: 'box-1', name: 'sid-xeon-1-dev' },
      name: 'review ISS-7',
    },
    job: null,
    ledger: null,
    workState: null,
    fleetKeys: [],
    liveJobs: 0,
    deployLocks: [],
    lockRefusals: [],
  } as unknown as RunFacts;
}

const running = { state: 'running', outcome: null } as unknown as Derived;

const held = (h: RunHolder) => h as Extract<RunHolder, { source: 'held' }>;

describe('a review run a person declared', () => {
  it('holds to the end its declaration names, not to a silence clock', () => {
    const holder = held(holderOf(reviewRun(minutes(40)), ctx, 'running'));
    expect(holder.expirySource).toBe('declaration');
    expect(holder.expiresAt).toBe(minutes(40).toISOString());
    expect(holder.verdict).toBe('live');
    expect(holder.expiryDetail).toBeNull();
    expect(holder.expiries[0]?.rule).toContain('declared it for review');
  });

  it('reads no silence as stuck before its end, twenty minutes unbeaten', () => {
    expect(stuckOf(reviewRun(minutes(40)), ctx, running)).toBeNull();
  });

  it('reads stuck once it stands past its end longer than the stuck clock', () => {
    const stuck = stuckOf(reviewRun(minutes(-4)), ctx, running);
    expect(stuck?.rule).toBe('silent');
    expect(stuck?.evidence.column).toBe('metadata.reviewRun.expiresAt');
  });

  it('leaves a run a master declared on the silence clock it always had', () => {
    const holder = held(holderOf(reviewRun(null), ctx, 'running'));
    expect(holder.expirySource).toBe('silence_reap');
    expect(stuckOf(reviewRun(null), ctx, running)?.rule).toBe('silent');
  });
});
