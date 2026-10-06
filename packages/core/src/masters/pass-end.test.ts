import type { MasterPassFacts } from '@forge/contracts/master-standing';
import { describe, expect, it } from 'vitest';
import { passEnd } from './pass-end.js';

// ADR 0009, What core takes over: the pass verdict was the runner's master_pass::judge; each case
// below is one of its branches, now judged from the facts the box reports on a settle.

const QUIET = 600_000;

function facts(over: Partial<MasterPassFacts> = {}): MasterPassFacts {
  return {
    openedBy: 'this_daemon',
    served: true,
    openedAgoMs: 1_000,
    hooks: { turnsSinceOpen: 0, turnBeganAgoMs: null, doing: 'idle', lastEventAgoMs: 1_000 },
    writtenAgoMs: null,
    dispatched: [],
    record: { worked: false, refusal: null },
    ...over,
  };
}

const hooks = (over: Partial<NonNullable<MasterPassFacts['hooks']>>) => ({
  turnsSinceOpen: 1,
  turnBeganAgoMs: 500,
  doing: 'idle' as const,
  lastEventAgoMs: 100,
  ...over,
});

describe('passEnd: how the box reports it held a pass', () => {
  it('closes a pass core named held open, one it could not record, and one an earlier daemon opened', () => {
    expect(passEnd(facts({ openedBy: 'adopted' }))?.reason).toBe('abandoned_orphan');
    expect(passEnd(facts({ openedBy: 'unrecorded' }))?.reason).toBe('unrecorded');
    expect(passEnd(facts({ openedBy: 'earlier_daemon' }))?.reason).toBe('abandoned_restart');
  });

  it('closes a pass whose session the box no longer serves the project under', () => {
    expect(passEnd(facts({ served: false }))?.reason).toBe('session_gone');
  });
});

describe('passEnd: the turn it covers', () => {
  it('a turn counted after the pass opened, begun after it, and over closes it', () => {
    expect(passEnd(facts({ hooks: hooks({}) }))).toMatchObject({ reason: 'turn_ended' });
    expect(passEnd(facts({ hooks: hooks({ doing: 'awaiting_children' }) }))?.reason).toBe(
      'turn_ended',
    );
    expect(passEnd(facts({ hooks: hooks({ doing: 'working' }) }))).toBeNull();
  });

  it('a notification turn running when the nudge was typed does not close its pass', () => {
    expect(passEnd(facts({ hooks: hooks({ turnBeganAgoMs: 1_001 }) }))).toBeNull();
    expect(passEnd(facts({ hooks: hooks({ turnsSinceOpen: 0 }) }))).toBeNull();
  });

  it('closes refused only where nothing ran inside it', () => {
    const refusal = { reason: 'usage_limit' as const, detail: "You've hit your limit" };
    const ended = (record: MasterPassFacts['record'], dispatched: string[] = []) =>
      passEnd(facts({ hooks: hooks({}), record, dispatched }))?.refused;
    expect(ended({ worked: false, refusal })).toEqual(refusal);
    expect(ended({ worked: true, refusal })).toBeNull();
    expect(ended({ worked: false, refusal }, ['ISS-A'])).toBeNull();
  });
});

describe('passEnd: a master quiet past the bound', () => {
  it('abandons a pass whose master said nothing for the bound, and not a millisecond sooner', () => {
    const idle = { turnsSinceOpen: 0, turnBeganAgoMs: null, doing: 'idle' as const };
    const at = (lastEventAgoMs: number) =>
      passEnd(facts({ openedAgoMs: QUIET * 2, hooks: { ...idle, lastEventAgoMs } }));
    expect(at(QUIET - 1)).toBeNull();
    expect(at(QUIET)?.reason).toBe('abandoned_quiet');
  });

  it('a transcript still being written is a master still working', () => {
    expect(
      passEnd(
        facts({
          openedAgoMs: QUIET * 2,
          hooks: hooks({ turnsSinceOpen: 0, lastEventAgoMs: QUIET * 2 }),
          writtenAgoMs: 1,
        }),
      ),
    ).toBeNull();
  });

  it('a session that never reported is measured from the pass opening', () => {
    expect(passEnd(facts({ hooks: null, openedAgoMs: QUIET }))?.reason).toBe('abandoned_quiet');
    expect(passEnd(facts({ hooks: null, openedAgoMs: QUIET - 1 }))).toBeNull();
  });

  it('a pane stopped on a question a person owes is waiting, not quiet', () => {
    expect(
      passEnd(
        facts({
          openedAgoMs: QUIET * 9,
          hooks: hooks({
            turnsSinceOpen: 0,
            doing: 'awaiting_permission',
            lastEventAgoMs: QUIET * 9,
          }),
        }),
      ),
    ).toBeNull();
  });
});
