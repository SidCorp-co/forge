// ISS-951 round 4: judge run e0121211 at dev.486 read Agenfold in Idle with backlog while its left text
// read "busy by hand". The group came from the master's state (`masters/state.ts:masterStateOf`) and
// "busy by hand" from the last pass's trigger. Every state × every last pass × every pool reading here:
// whatever the left text says (what the master does, or why it took nothing) agrees with the group.

import { MASTER_PASS_TRIGGERS, type MasterState } from '@forge/contracts/master-standing';
import type { OrgActivityGroup } from '@forge/contracts/org-activity';
import { describe, expect, it } from 'vitest';
import type { MasterGlance } from '../masters/index.js';
import { doingOf, groupOf, skipOf } from './group.js';

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

const row = (m: MasterGlance, backlog: number) => {
  const master = {
    state: m.state,
    since: null,
    lastPassEndedAt: null,
    lastBeatAt: null,
    silentAfterSeconds: 300,
    pane: null,
    doing: doingOf(m, () => 'a title'),
    dialog: null,
  };
  const base = {
    master,
    next: { total: backlog, items: [], skip: skipOf(m, backlog) },
    people: { total: 0, items: [] },
    awaitingRelease: 0,
  };
  return { ...base, group: groupOf(base) };
};

/** The groups each left text may sit in. */
const AGREES: Record<string, readonly OrgActivityGroup[]> = {
  busy_by_hand: ['running'],
  pass: ['running', 'waiting'],
  run: ['running'],
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
    const said = r.master.doing?.kind ?? r.next.skip;
    if (said && said in AGREES) {
      expect(AGREES[said], `${said} beside ${r.group}`).toContain(r.group);
    }
    if (r.group === 'idle') {
      expect(r.master.doing, 'an idle row named what its master does').toBeNull();
      expect(r.next.skip).not.toBe('busy_by_hand');
    }
  });

  it('Agenfold at dev.486: idle since a turn begun by hand reads idle, and not busy by hand', () => {
    const m = glance({
      state: 'idle',
      lastPass: { endedAt: '2026-11-04T09:00:00.000Z', dispatched: [], trigger: 'unprompted' },
    });
    const r = row(m, 12);
    expect(r.group).toBe('idle');
    expect(r.next.skip).toBeNull();
  });

  it('working by hand now reads busy by hand, in Running', () => {
    const m = glance({
      state: 'busy',
      lastPass: { endedAt: '2026-11-04T09:00:00.000Z', dispatched: [], trigger: 'nudge' },
    });
    const r = row(m, 12);
    expect([r.group, r.next.skip]).toEqual(['running', 'busy_by_hand']);
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
