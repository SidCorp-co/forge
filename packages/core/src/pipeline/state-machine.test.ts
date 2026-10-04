import { PARKABLE_ISSUE_STATUSES } from '@forge/contracts';
import { describe, expect, it } from 'vitest';
import { type IssueStatus, issueStatuses } from '../db/schema.js';
import {
  canTransition,
  DRAFT_EXIT_TARGETS,
  getAllowedTransitions,
  isRecoveryEdge,
  PARK_STATUSES,
  PARKABLE_STATUSES,
  parkExitTargets,
  transitions,
} from './state-machine.js';

// Workflow `issue-lifecycle`, approved revision 3 (ISS-54): the forward edges, written out here so a
// change to the table is a change to this file too.
const EXPECTED_EXITS: Record<IssueStatus, readonly IssueStatus[]> = {
  draft: ['dropped', 'open'],
  open: ['dropped', 'in_progress', 'needs_info', 'on_hold'],
  reopen: ['dropped', 'in_progress', 'needs_info', 'on_hold'],
  in_progress: ['approved', 'awaiting_release', 'closed', 'dropped', 'needs_info', 'on_hold'],
  approved: ['dropped', 'in_progress', 'needs_info', 'on_hold'],
  awaiting_release: ['closed', 'dropped', 'needs_info', 'on_hold', 'reopen'],
  needs_info: ['dropped', 'on_hold'],
  on_hold: ['dropped', 'needs_info'],
  closed: ['reopen'],
  dropped: [],
};

describe('the issue lifecycle', () => {
  it('has exactly the ten statuses of the approved workflow', () => {
    expect([...issueStatuses].sort()).toEqual(
      [
        'approved',
        'awaiting_release',
        'closed',
        'draft',
        'dropped',
        'in_progress',
        'needs_info',
        'on_hold',
        'open',
        'reopen',
      ].sort(),
    );
    for (const retired of [
      'confirmed',
      'clarified',
      'developed',
      'testing',
      'tested',
      'releasing',
      'waiting',
    ]) {
      expect(issueStatuses as readonly string[]).not.toContain(retired);
    }
  });

  it.each(issueStatuses.map((s) => [s]))('%s has exactly its forward edges', (from) => {
    expect([...getAllowedTransitions(from)].sort()).toEqual([...EXPECTED_EXITS[from]].sort());
    expect([...transitions[from]].sort()).toEqual([...EXPECTED_EXITS[from]].sort());
  });

  it('refuses every pair outside the table (non-park sources)', () => {
    for (const from of issueStatuses) {
      if (PARK_STATUSES.includes(from)) continue;
      for (const to of issueStatuses) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(EXPECTED_EXITS[from].includes(to));
      }
    }
  });

  it('never re-enters draft, from anywhere', () => {
    for (const from of issueStatuses) {
      expect(canTransition(from, 'draft', 'open'), `${from} -> draft`).toBe(false);
    }
    expect(DRAFT_EXIT_TARGETS).toEqual(['open', 'dropped']);
  });

  it('gives dropped no exit and closed only reopen', () => {
    for (const to of issueStatuses) expect(canTransition('dropped', to)).toBe(false);
    expect(issueStatuses.filter((to) => canTransition('closed', to))).toEqual(['reopen']);
  });

  it('reaches reopen only from awaiting_release and closed', () => {
    const into = issueStatuses.filter(
      (from) => !PARK_STATUSES.includes(from) && canTransition(from, 'reopen'),
    );
    expect(into).toEqual(['awaiting_release', 'closed']);
  });

  it('reaches awaiting_release only from in_progress (and a park returning to it)', () => {
    const into = issueStatuses.filter(
      (from) => !PARK_STATUSES.includes(from) && canTransition(from, 'awaiting_release'),
    );
    expect(into).toEqual(['in_progress']);
  });
});

describe('the parks return to the status they left', () => {
  it.each(PARK_STATUSES.flatMap((park) => PARKABLE_STATUSES.map((left) => [park, left] as const)))(
    '%s left from %s returns only there',
    (park, left) => {
      const allowed = issueStatuses.filter((to) => canTransition(park, to, left));
      const other = park === 'needs_info' ? 'on_hold' : 'needs_info';
      expect(allowed.sort()).toEqual([left, other, 'dropped'].sort());
      for (const elsewhere of PARKABLE_STATUSES.filter((s) => s !== left)) {
        expect(canTransition(park, elsewhere, left), `${park}(${left}) -> ${elsewhere}`).toBe(
          false,
        );
      }
    },
  );

  it('is the set the browser offers, from contracts', () => {
    expect([...PARKABLE_ISSUE_STATUSES].sort()).toEqual([...PARKABLE_STATUSES].sort());
  });

  it('a park with no recorded left status lets a person name any parkable status', () => {
    expect([...parkExitTargets('needs_info', null)].sort()).toEqual(
      [...PARKABLE_STATUSES, 'on_hold', 'dropped'].sort(),
    );
    expect(canTransition('needs_info', 'draft', null)).toBe(false);
    expect(canTransition('on_hold', 'closed', null)).toBe(false);
  });

  it('is entered from every live status but draft', () => {
    for (const park of PARK_STATUSES) {
      const from = issueStatuses.filter(
        (s) => !PARK_STATUSES.includes(s) && canTransition(s, park),
      );
      expect(from.sort()).toEqual([...PARKABLE_STATUSES].sort());
    }
  });
});

describe('the kernel recovery edges', () => {
  it('hands an unheld in_progress back to where a master takes it, and nothing else', () => {
    for (const from of issueStatuses) {
      for (const to of issueStatuses) {
        const expected = from === 'in_progress' && ['open', 'approved', 'reopen'].includes(to);
        expect(isRecoveryEdge(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('are not lifecycle moves', () => {
    expect(canTransition('in_progress', 'open')).toBe(false);
    expect(canTransition('in_progress', 'reopen')).toBe(false);
  });
});
