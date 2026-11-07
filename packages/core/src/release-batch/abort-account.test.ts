import type { ReleasePerson } from '@forge/contracts/releases';
import { describe, expect, it } from 'vitest';
import { abortActorOf, abortViewOf, NO_ABORT_RECORDED } from './abort-account.js';
import { readAbortStamp } from './abort-stamp.js';

// ISS-1095, sidpeak 0.24.0: the abort recorded its reason, its actor, a blocker and the carried tag,
// and both reads of the run dropped it. Here is the one reading they now share.

const AGENT: ReleasePerson = { id: 'agent-1', name: 'sidpeak-release', kind: 'agent' };
const people = new Map([[AGENT.id, AGENT]]);

const stamp = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  at: '2026-11-07T04:00:00.000Z',
  reason: 'the production deploy waits on a person (awaiting-prod-confirm)',
  by: AGENT.id,
  roster: 'released',
  closed: [],
  blocker: { owes: 'human', waitingFor: 'confirm-prod-deploy' },
  pushed: true,
  ...over,
});

const run = (metadata: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  status: 'cancelled',
  releasedAt: null,
  reachedBox: true,
  metadata,
  ...over,
});

describe('abortViewOf', () => {
  it('reads the whole account an abort recorded: reason, agent by handle, blocker, push, carried tag', () => {
    const view = abortViewOf(
      run({ abort: stamp(), carried: { carriers: [{ kind: 'tag', name: 'v0.24.0' }] } }),
      people,
    );
    expect(view).toEqual({
      recorded: true,
      reason: 'the production deploy waits on a person (awaiting-prod-confirm)',
      by: AGENT,
      at: '2026-11-07T04:00:00.000Z',
      blocker: { owes: 'human', waitingFor: 'confirm-prod-deploy' },
      pushed: true,
      roster: 'released',
      carried: [{ kind: 'tag', name: 'v0.24.0' }],
    });
  });

  it('says nothing it was not told: no blocker, push or carrier where the abort named none', () => {
    const view = abortViewOf(
      run({ abort: stamp({ blocker: undefined, pushed: undefined }) }),
      people,
    );
    expect(view).toMatchObject({ recorded: true, blocker: null, pushed: null, carried: null });
  });

  it('reads `pushed: false` as nothing carried, and an actor Forge does not know as nobody', () => {
    const view = abortViewOf(run({ abort: stamp({ pushed: false, by: 'gone' }) }), people);
    expect(view).toMatchObject({ recorded: true, pushed: false, carried: [], by: null });
  });

  it('reads an abort still returning its roster on a run not yet cancelled', () => {
    const view = abortViewOf(
      run({ abort: stamp({ roster: 'returning' }) }, { status: 'running' }),
      people,
    );
    expect(view).toMatchObject({ recorded: true, roster: 'returning' });
  });

  it('says a cancel with no abort recorded by name', () => {
    expect(abortViewOf(run({}), people)).toEqual({ recorded: false, says: NO_ABORT_RECORDED });
    const failedSince761 = run(
      { failure: { code: 'release_cancelled_without_abort', detail: 'cancelled', at: 'x' } },
      { status: 'failed' },
    );
    expect(abortViewOf(failedSince761, people)).toEqual({
      recorded: false,
      says: NO_ABORT_RECORDED,
    });
  });

  it('reads no abort on a run nobody aborted, one that failed otherwise, or one that shipped', () => {
    expect(abortViewOf(run({}, { status: 'running' }), people)).toBeNull();
    expect(
      abortViewOf(
        run({ failure: { code: 'release_not_shipped', detail: 'x', at: 'x' } }, { status: 'failed' }),
        people,
      ),
    ).toBeNull();
    expect(abortViewOf(run({}, { releasedAt: new Date() }), people)).toBeNull();
  });
});

describe('readAbortStamp', () => {
  it('keeps the blocker the abort wrote, and drops one it cannot name', () => {
    expect(readAbortStamp({ abort: stamp() })?.blocker).toEqual({
      owes: 'human',
      waitingFor: 'confirm-prod-deploy',
    });
    expect(
      readAbortStamp({ abort: stamp({ blocker: { owes: 'robot', waitingFor: 'x' } }) })?.blocker,
    ).toBeUndefined();
  });

  it('names the actor to read with the other people', () => {
    expect(abortActorOf({ abort: stamp() })).toBe(AGENT.id);
    expect(abortActorOf({})).toBeNull();
  });
});
