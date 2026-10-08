import { describe, expect, it } from 'vitest';
import { AUTONOMOUS_LABELS, toAutonomousLabel } from './issue-vocabulary.js';
import { REGISTRY_ISSUE_STATUSES } from './pipeline-registry.js';
import {
  isWorkState,
  missingWorkStateKey,
  LABEL_WORK_STATE,
  OPEN_WORK_STATES,
  openWorkTotal,
  STATUS_WORK_STATE,
  statusesInWorkState,
  WORK_STATE_LABELS,
  WORK_STATES,
  workStateOf,
} from './work-state.js';

describe('the status map', () => {
  it('puts every kernel status in exactly one state, and every state is one of the six', () => {
    expect(Object.keys(STATUS_WORK_STATE).sort()).toEqual([...REGISTRY_ISSUE_STATUSES].sort());
    for (const status of REGISTRY_ISSUE_STATUSES) {
      expect(WORK_STATES).toContain(STATUS_WORK_STATE[status]);
    }
  });

  it('partitions the statuses: the state lists add up to the registry with nothing counted twice', () => {
    const listed = WORK_STATES.flatMap((s) => statusesInWorkState(s));
    expect([...listed].sort()).toEqual([...REGISTRY_ISSUE_STATUSES].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('files each status where the help page says who holds it', () => {
    const where = (state: (typeof WORK_STATES)[number]) => statusesInWorkState(state).sort();
    expect(where('open')).toEqual(['open']);
    expect(where('in_flight')).toEqual(
      [
        'approved',
        'clarified',
        'confirmed',
        'developed',
        'in_progress',
        'releasing',
        'testing',
      ].sort(),
    );
    expect(where('awaiting_release')).toEqual(['awaiting_release', 'tested']);
    expect(where('blocked_on_person')).toEqual(['needs_info', 'on_hold', 'reopen', 'waiting']);
    expect(where('draft')).toEqual(['draft']);
    expect(where('finished')).toEqual(['closed', 'dropped']);
  });

  it('has a word for every state, all different', () => {
    expect(Object.keys(WORK_STATE_LABELS).sort()).toEqual([...WORK_STATES].sort());
    expect(new Set(Object.values(WORK_STATE_LABELS)).size).toBe(WORK_STATES.length);
  });

  it("uses the Overview's four words for the four open states", () => {
    expect(OPEN_WORK_STATES.map((s) => WORK_STATE_LABELS[s])).toEqual([
      'Open, not picked up',
      'In flight',
      'Awaiting release',
      'Blocked on a person',
    ]);
  });
});

describe('workStateOf', () => {
  it('reads a status as its own state when nobody owes an answer', () => {
    for (const status of REGISTRY_ISSUE_STATUSES) {
      expect(workStateOf(status)).toBe(STATUS_WORK_STATE[status]);
      expect(workStateOf(status, false)).toBe(STATUS_WORK_STATE[status]);
    }
  });

  it('reads an issue not yet picked up, or in flight, as blocked on a person while one is owed an answer', () => {
    for (const status of REGISTRY_ISSUE_STATUSES) {
      const own = STATUS_WORK_STATE[status];
      if (own === 'open' || own === 'in_flight') {
        expect([status, workStateOf(status, true)]).toEqual([status, 'blocked_on_person']);
      }
    }
  });

  it('moves no other status for a question: the release gate, drafts and finished work stay put', () => {
    for (const status of REGISTRY_ISSUE_STATUSES) {
      const own = STATUS_WORK_STATE[status];
      if (own === 'open' || own === 'in_flight') continue;
      expect([status, workStateOf(status, true)]).toEqual([status, own]);
    }
  });
});

describe('the lane is a refinement of the states', () => {
  it('names a state for every lane label', () => {
    expect(Object.keys(LABEL_WORK_STATE).sort()).toEqual([...AUTONOMOUS_LABELS].sort());
  });

  it('reads the same state through a status as through the label the lane gives it, held or not, owed or not', () => {
    for (const status of REGISTRY_ISSUE_STATUSES) {
      for (const held of [true, false]) {
        for (const owes of [true, false]) {
          const label = toAutonomousLabel(status, held, owes);
          expect([status, held, owes, LABEL_WORK_STATE[label]]).toEqual([
            status,
            held,
            owes,
            workStateOf(status, owes),
          ]);
        }
      }
    }
  });

  it('turns a question on an unheld row into needs_human, and leaves a parked row alone', () => {
    expect(toAutonomousLabel('testing', false, true)).toBe('needs_human');
    expect(toAutonomousLabel('open', true, true)).toBe('needs_human');
    expect(toAutonomousLabel('awaiting_release', true, true)).toBe('awaiting_release');
    expect(toAutonomousLabel('closed', true, true)).toBe('done');
  });
});

describe('open work', () => {
  it('is the four open states, and neither drafts nor finished work', () => {
    expect([...OPEN_WORK_STATES]).toEqual([
      'open',
      'in_flight',
      'awaiting_release',
      'blocked_on_person',
    ]);
  });

  it('sums the four open states and nothing else', () => {
    expect(
      openWorkTotal({
        open: 56,
        in_flight: 11,
        awaiting_release: 1,
        blocked_on_person: 4,
        draft: 24,
        finished: 1306,
      }),
    ).toBe(72);
    expect(openWorkTotal({})).toBe(0);
  });
});

describe('isWorkState', () => {
  it('admits the six and refuses a status, a lane label and a stranger', () => {
    for (const s of WORK_STATES) expect(isWorkState(s)).toBe(true);
    for (const v of ['in_progress', 'running', 'you', 'agent', '', undefined, 3]) {
      expect(isWorkState(v)).toBe(false);
    }
  });
});

describe('missingWorkStateKey', () => {
  const full = {
    open: 0,
    in_flight: 0,
    awaiting_release: 0,
    blocked_on_person: 0,
    draft: 0,
    finished: 0,
  };

  it('is null for a count of every state', () => {
    expect(missingWorkStateKey(full)).toBeNull();
  });

  it('names the first state a count lacks, so an older core is refused by name', () => {
    const { in_flight: _dropped, ...without } = full;
    expect(missingWorkStateKey(without)).toBe('in_flight');
    expect(missingWorkStateKey({ ...full, finished: '3' })).toBe('finished');
  });

  it('names a count that is not an object at all', () => {
    expect(missingWorkStateKey(undefined)).toBe('open');
    expect(missingWorkStateKey(null)).toBe('open');
    expect(missingWorkStateKey({ open: 1 }, ['open'])).toBeNull();
  });
});
