import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { liveOf } from './standing-live.js';
import type { RunFacts, StandingContext } from './standing-types.js';

// ISS-576: a run its master still holds is kept while its agent works even once every issue it holds
// is over (a release judge, whose issues the release closed). Its standing says why it is held and
// that its master acts next, never "its holder is working it" over closed issues.

const now = new Date('2026-10-24T12:00:00Z');
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

const ctx = {
  now,
  viewer: null,
  slots: null,
  queuedGates: new Map(),
  stuckAfterMs: 3 * 60_000,
} as unknown as StandingContext;

function judge(statuses: Record<string, string>, over: Record<string, unknown> = {}): RunFacts {
  return {
    run: {
      id: 'run-judge',
      status: 'running',
      startedAt: minutes(-30),
      updatedAt: minutes(-30),
      pauseReason: null,
      releaseVersion: null,
      declarationRefusal: null,
    },
    issue: null,
    issues: Object.keys(statuses),
    statuses,
    session: {
      id: 'session-judge',
      status: 'running',
      runtimeState: null,
      startedAt: minutes(-30),
      createdAt: minutes(-30),
    },
    job: null,
    ledger: null,
    question: null,
    approval: null,
    master: { sessionId: 'master-1', name: 'forge-master-forge', live: true, dialog: null },
    liveJobs: 0,
    deployLocks: [],
    lockRefusals: [],
    releaseAttempt: null,
    ...over,
  } as unknown as RunFacts;
}

const live = (f: RunFacts) => {
  const d = liveOf(f, ctx);
  expect(saidDisagreements(d)).toEqual([]);
  return d;
};

describe('ISS-576 a live run whose every issue is over', () => {
  it('stands held on its master, naming the closed issues as the cause', () => {
    const d = live(judge({ 'ISS-1': 'closed', 'ISS-2': 'dropped' }));
    expect(d.state).toBe('running');
    expect(d.rule).toEqual(
      expect.objectContaining({
        key: 'runs.live.heldIssuesOver',
        vars: { issues: 'ISS-1, ISS-2' },
      }),
    );
    expect(d.waitingOn).toMatchObject({
      kind: 'master',
      who: 'forge-master-forge',
      act: 'close the run once its agent reports',
      rule: 'held: every issue it holds is over; its master closes it',
    });
  });
  it('names the master generically where the run records no master name', () => {
    const d = live(judge({ 'ISS-1': 'closed' }, { master: null }));
    expect(d.waitingOn).toMatchObject({ kind: 'master', who: 'Master' });
  });
  it('stays at work while one issue it holds is not over, or its status is not known', () => {
    for (const statuses of [
      { 'ISS-1': 'closed', 'ISS-2': 'awaiting_release' },
      { 'ISS-1': 'in_progress' },
    ]) {
      const d = live(judge(statuses));
      expect(d.waitingOn.kind).toBe('none');
      expect(d.rule).toEqual(expect.objectContaining({ key: 'runs.live.sessionIs' }));
    }
    const unread = live(judge({}, { issues: ['ISS-1'] }));
    expect(unread.waitingOn.kind).toBe('none');
  });
  it('says nothing of it for a run that holds no issue', () => {
    expect(live(judge({})).waitingOn.kind).toBe('none');
  });
});
