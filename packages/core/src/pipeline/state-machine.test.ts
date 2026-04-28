import { describe, expect, it } from 'vitest';
import { issueStatuses } from '../db/schema.js';
import {
  REOPEN_CAP,
  canTransition,
  getAllowedTransitions,
  isReopenEntry,
  transitions,
} from './state-machine.js';

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

  it('on_hold can resume to any non-on_hold status', () => {
    const resumable = issueStatuses.filter((s) => s !== 'on_hold');
    expect([...transitions.on_hold]).toEqual(resumable);
  });

  it('released can only move to closed or on_hold', () => {
    expect([...transitions.released].sort()).toEqual(['closed', 'on_hold']);
  });

  it('isReopenEntry is true only for closed → reopen', () => {
    expect(isReopenEntry('closed', 'reopen')).toBe(true);
    expect(isReopenEntry('developed', 'reopen')).toBe(false);
    expect(isReopenEntry('closed', 'developed')).toBe(false);
  });

  it('REOPEN_CAP is 5', () => {
    expect(REOPEN_CAP).toBe(5);
  });
});
