import { describe, expect, it } from 'vitest';
import { issueStatuses } from '../db/schema.js';
import {
  canTransition,
  canTransitionFree,
  DRAFT_EXIT_TARGETS,
  getAllowedTransitions,
  isReopenEntry,
  transitions,
} from './state-machine.js';

const EXPECTED_EXITS: Record<string, readonly string[]> = {
  draft: ['closed', 'developed', 'dropped', 'in_progress', 'open'],
  open: ['confirmed', 'dropped', 'in_progress', 'needs_info', 'on_hold'],
  confirmed: ['approved', 'dropped', 'in_progress', 'needs_info', 'on_hold'],
  approved: ['dropped', 'in_progress', 'needs_info', 'on_hold'],
  in_progress: ['closed', 'developed', 'dropped', 'needs_info', 'on_hold'],
  developed: ['dropped', 'needs_info', 'on_hold', 'reopen', 'testing'],
  testing: ['awaiting_release', 'closed', 'dropped', 'needs_info', 'on_hold', 'reopen'],
  awaiting_release: ['dropped', 'needs_info', 'on_hold', 'releasing'],
  releasing: ['closed', 'needs_info', 'on_hold', 'reopen'],
  needs_info: [
    'approved',
    'awaiting_release',
    'confirmed',
    'developed',
    'dropped',
    'in_progress',
    'on_hold',
    'open',
    'testing',
  ],
  on_hold: [
    'approved',
    'awaiting_release',
    'confirmed',
    'developed',
    'dropped',
    'in_progress',
    'needs_info',
    'open',
    'testing',
  ],
  reopen: ['developed', 'dropped', 'in_progress', 'needs_info', 'on_hold'],
  closed: ['reopen'],
  dropped: [],
  clarified: ['dropped', 'in_progress', 'needs_info', 'on_hold'],
  waiting: ['dropped', 'in_progress', 'needs_info', 'on_hold', 'open'],
  tested: ['awaiting_release', 'closed', 'dropped', 'needs_info', 'on_hold', 'reopen'],
};

const DRAFT_MAY_REACH = ['open', 'closed', 'dropped', 'developed', 'in_progress'];

function acceptedByTheDocumentedRules(from: string, to: string): boolean {
  if (to === 'draft') return false;
  if (from === 'draft') return DRAFT_MAY_REACH.includes(to);
  return true;
}

describe('canTransitionFree over every ordered pair', () => {
  it('answers the documented rules for all 17 x 17 pairs', () => {
    const disagreed: string[] = [];
    for (const from of issueStatuses) {
      for (const to of issueStatuses) {
        const expected = acceptedByTheDocumentedRules(from, to);
        if (canTransitionFree(from, to) !== expected) disagreed.push(`${from} -> ${to}`);
      }
    }
    expect(disagreed).toEqual([]);
  });

  it('counts the pairs it actually walked, so a shrunken enum cannot pass it silently', () => {
    expect(issueStatuses.length).toBe(17);
    const pairs = issueStatuses.length * issueStatuses.length;
    expect(pairs).toBe(289);
  });
});

describe('state machine', () => {
  it('defines transitions for every issue status', () => {
    for (const s of issueStatuses) {
      expect(transitions[s]).toBeDefined();
    }
  });

  it('every target status in every list is a valid issue status', () => {
    for (const s of issueStatuses) {
      for (const t of transitions[s]) {
        expect(issueStatuses).toContain(t);
      }
    }
  });

  it('no self-transitions (covered by NO_OP check in handler)', () => {
    for (const s of issueStatuses) {
      expect(transitions[s]).not.toContain(s);
    }
  });

  it('canTransition returns the matrix value for every pair', () => {
    for (const from of issueStatuses) {
      for (const to of issueStatuses) {
        const expected = transitions[from].includes(to);
        expect(canTransition(from, to)).toBe(expected);
      }
    }
  });

  it('getAllowedTransitions returns the declared list', () => {
    for (const s of issueStatuses) {
      expect(getAllowedTransitions(s)).toBe(transitions[s]);
    }
  });

  it('closed can only transition to reopen', () => {
    expect(transitions.closed).toEqual(['reopen']);
  });

  it('dropped is terminal with no exit at all', () => {
    expect([...transitions.dropped]).toEqual([]);
  });

  it('a park resumes onto a live rung, never a retired one', () => {
    for (const live of [
      'open',
      'confirmed',
      'approved',
      'in_progress',
      'developed',
      'testing',
      'awaiting_release',
    ] as const) {
      expect(transitions.on_hold, `on_hold → ${live}`).toContain(live);
      expect(transitions.needs_info, `needs_info → ${live}`).toContain(live);
    }
    for (const retired of ['clarified', 'waiting', 'tested'] as const) {
      expect(transitions.on_hold, `on_hold → ${retired}`).not.toContain(retired);
      expect(transitions.needs_info, `needs_info → ${retired}`).not.toContain(retired);
    }
  });

  it('every row offers exactly these exits', () => {
    expect(Object.keys(EXPECTED_EXITS).sort()).toEqual([...issueStatuses].sort());
    for (const status of issueStatuses) {
      expect([...transitions[status]].sort(), `${status} exits`).toEqual(
        [...(EXPECTED_EXITS[status] ?? [])].sort(),
      );
    }
  });

  it('suggests every legal draft exit and no other (ISS-236, ISS-940)', () => {
    expect([...transitions.draft].sort()).toEqual([
      'closed',
      'developed',
      'dropped',
      'in_progress',
      'open',
    ]);
  });

  it('no status maps INTO draft (ISS-236)', () => {
    for (const from of issueStatuses) {
      if (from === 'draft') continue;
      expect(canTransition(from, 'draft')).toBe(false);
    }
  });

  it('draft rejects every transition target outside its five exits (ISS-236, ISS-940)', () => {
    for (const to of issueStatuses) {
      const expected =
        to === 'open' ||
        to === 'closed' ||
        to === 'dropped' ||
        to === 'developed' ||
        to === 'in_progress';
      expect(canTransition('draft', to)).toBe(expected);
    }
  });

  it('awaiting_release exits to the release starting, the parks, or a discard', () => {
    expect([...transitions.awaiting_release].sort()).toEqual([
      'dropped',
      'needs_info',
      'on_hold',
      'releasing',
    ]);
  });

  it('releasing exits only to the two release outcomes and the two parks', () => {
    expect([...transitions.releasing].sort()).toEqual([
      'closed',
      'needs_info',
      'on_hold',
      'reopen',
    ]);
  });

  it('isReopenEntry counts every entry into reopen, not just from closed (ISS-781)', () => {
    expect(isReopenEntry('closed', 'reopen')).toBe(true);
    expect(isReopenEntry('developed', 'reopen')).toBe(true);
    expect(isReopenEntry('testing', 'reopen')).toBe(true);
    expect(isReopenEntry('tested', 'reopen')).toBe(true);
    expect(isReopenEntry('reopen', 'reopen')).toBe(false);
    expect(isReopenEntry('closed', 'developed')).toBe(false);
  });

  it('isReopenEntry excludes in_progress → reopen — a system revert, not an agent rejection (ISS-766)', () => {
    expect(isReopenEntry('in_progress', 'reopen')).toBe(false);
    expect(isReopenEntry('developed', 'reopen')).toBe(true);
    expect(isReopenEntry('testing', 'reopen')).toBe(true);
  });

  describe('canTransitionFree (permissive runtime guard)', () => {
    it('allows any non-draft target from any runtime state', () => {
      expect(canTransitionFree('open', 'awaiting_release')).toBe(true);
      expect(canTransitionFree('approved', 'needs_info')).toBe(true);
      expect(canTransitionFree('developed', 'reopen')).toBe(true);
      expect(canTransitionFree('tested', 'on_hold')).toBe(true);
    });

    it('never allows draft as a target', () => {
      for (const from of issueStatuses) {
        expect(canTransitionFree(from, 'draft')).toBe(false);
      }
    });

    it('restricts a draft source to promotion, discard, direct-ship and taking it up in place', () => {
      expect(canTransitionFree('draft', 'open')).toBe(true);
      expect(canTransitionFree('draft', 'closed')).toBe(true);
      expect(canTransitionFree('draft', 'developed')).toBe(true);
      expect(canTransitionFree('draft', 'in_progress')).toBe(true);
      expect(canTransitionFree('draft', 'approved')).toBe(false);
      expect(canTransitionFree('draft', 'testing')).toBe(false);
      expect(canTransitionFree('draft', 'awaiting_release')).toBe(false);
    });

    it('exits a draft to exactly these five statuses and no others', () => {
      const expected = ['closed', 'developed', 'dropped', 'in_progress', 'open'];
      const allowed = issueStatuses.filter(
        (to) => to !== 'draft' && canTransitionFree('draft', to),
      );
      expect([...allowed].sort()).toEqual(expected);
      expect([...DRAFT_EXIT_TARGETS].sort()).toEqual(expected);
    });
  });
});
