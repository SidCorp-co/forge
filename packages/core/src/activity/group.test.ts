// ISS-951 round 4: judge run e0121211 at dev.486 read Agenfold in Idle with backlog while its left text
// read "busy by hand". The group came from the master's state (`masters/state.ts:masterStateOf`) and
// "busy by hand" from the last pass's trigger. Every state × every last pass × every pool reading here:
// whatever the left text says (what the master does, or why it took nothing) agrees with the group.
// ISS-979: the row's standing is that one state (Working · Idle · Paused · No master), and anything
// waiting on the reader puts the row first, in Waiting on you, whatever its master does.

import { MASTER_PASS_TRIGGERS, type MasterState } from '@forge/contracts/master-standing';
import type { OrgActivityStanding } from '@forge/contracts/org-activity';
import { describe, expect, it } from 'vitest';
import type { MasterGlance } from '../masters/index.js';
import { doingOf, groupOf, pauseOf, skipOf, standingOf } from './group.js';

const STATES = [
  'in_pass',
  'busy',
  'runs_out',
  'idle',
  'waiting_person',
  'silent',
] as const satisfies readonly Exclude<MasterState, 'none'>[];

const glance = (over: Partial<MasterGlance>): MasterGlance => ({
  state: 'idle',
  since: null,
  pass: null,
  lastPass: null,
  runsOut: 0,
  lastBeatAt: null,
  pane: null,
  dialog: null,
  slotsFull: false,
  poolClosed: false,
  newestRunIssue: null,
  ...over,
});

const row = (m: MasterGlance, backlog: number, waiting = 0) => {
  const standing = standingOf(m);
  return {
    standing,
    pause: pauseOf(m),
    group: groupOf(standing, waiting),
    doing: doingOf(m, () => 'a title'),
    skip: skipOf(m, backlog),
  };
};

/** The standings each left text may sit beside. */
const AGREES: Record<string, readonly OrgActivityStanding[]> = {
  busy_by_hand: ['working'],
  pass: ['working', 'paused'],
  run: ['working'],
};

describe('a row says one thing about its master', () => {
  const cases = STATES.flatMap((state) =>
    MASTER_PASS_TRIGGERS.flatMap((trigger) =>
      [false, true].flatMap((poolClosed) =>
        [0, 2].map((runsOut) => ({ state, trigger, poolClosed, runsOut })),
      ),
    ),
  );

  it.each(cases)('$state, last pass $trigger, pool closed $poolClosed, $runsOut runs out', (c) => {
    const m = glance({
      state: c.state,
      pass:
        c.state === 'in_pass' || c.state === 'waiting_person' || c.state === 'silent'
          ? {
              id: 'p',
              sessionId: 's',
              verb: 'dispatch',
              startedAt: '2026-11-04T10:00:00.000Z',
              issueKey: 'ISS-1',
              trigger: 'nudge',
            }
          : null,
      lastPass: { endedAt: '2026-11-04T09:00:00.000Z', dispatched: [], trigger: c.trigger },
      runsOut: c.runsOut,
      poolClosed: c.poolClosed,
      newestRunIssue: 'ISS-2',
    });
    const r = row(m, 3);
    const said = r.doing?.kind ?? r.skip;
    if (said && said in AGREES) {
      expect(AGREES[said], `${said} beside ${r.standing}`).toContain(r.standing);
    }
    if (r.standing === 'idle') {
      expect(r.doing, 'an idle row named what its master does').toBeNull();
      expect(r.skip).not.toBe('busy_by_hand');
    }
    // a pause always says why, and only a paused row carries a reason
    expect(r.pause !== null, `${c.state} paused by ${r.pause}`).toBe(r.standing === 'paused');
    expect(r.group, 'a row with nothing waiting on the reader left its standing').toBe(r.standing);
    expect(row(m, 3, 2).group, 'a row with something waiting on the reader is not first').toBe(
      'you',
    );
  });

  it('Agenfold at dev.486: idle since a turn begun by hand reads idle, and not busy by hand', () => {
    const m = glance({
      state: 'idle',
      lastPass: { endedAt: '2026-11-04T09:00:00.000Z', dispatched: [], trigger: 'unprompted' },
    });
    const r = row(m, 12);
    expect(r.group).toBe('idle');
    expect(r.skip).toBeNull();
  });

  it('working by hand now reads busy by hand, in Working', () => {
    const m = glance({
      state: 'busy',
      lastPass: { endedAt: '2026-11-04T09:00:00.000Z', dispatched: [], trigger: 'nudge' },
    });
    const r = row(m, 12);
    expect([r.group, r.skip]).toEqual(['working', 'busy_by_hand']);
  });

  it('a master that takes no new work reads Paused, and says why only in its reason', () => {
    expect([standingOf(glance({ state: 'silent' })), pauseOf(glance({ state: 'silent' }))]).toEqual(
      ['paused', 'silent'],
    );
    const dialog = glance({ state: 'waiting_person' });
    expect([standingOf(dialog), pauseOf(dialog)]).toEqual(['paused', 'dialog']);
    const closed = glance({ state: 'idle', poolClosed: true });
    expect([standingOf(closed), pauseOf(closed)]).toEqual(['paused', 'no_new_work']);
    // a box that takes no new run while its runs are still out is still working
    const out = glance({ state: 'runs_out', runsOut: 1, poolClosed: true });
    expect([standingOf(out), pauseOf(out)]).toEqual(['working', null]);
  });

  it('no master stands: No master, and waiting on the reader still puts it first', () => {
    expect([standingOf(undefined), pauseOf(undefined), groupOf(standingOf(undefined), 0)]).toEqual([
      'none',
      null,
      'none',
    ]);
    expect(groupOf('none', 1)).toBe('you');
  });

  it('a silent master names nothing it does, though its last pass is still open', () => {
    const m = glance({
      state: 'silent',
      pass: {
        id: 'p',
        sessionId: 's',
        verb: 'dispatch',
        startedAt: '2026-11-04T10:00:00.000Z',
        issueKey: 'ISS-1',
        trigger: 'nudge',
      },
    });
    expect(doingOf(m, () => 'a title')).toBeNull();
  });

  it('names the issue by the title it is given', () => {
    const m = glance({
      state: 'runs_out',
      runsOut: 1,
      newestRunIssue: 'ISS-2',
    });
    expect(doingOf(m, (k) => (k === 'ISS-2' ? 'Builds the timeline' : null))).toEqual({
      kind: 'run',
      verb: null,
      issueKey: 'ISS-2',
      issueTitle: 'Builds the timeline',
    });
  });
});
