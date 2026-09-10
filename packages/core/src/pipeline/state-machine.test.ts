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

  // cm:guard `dropped` must stay a dead end: `closed → reopen` exists because a closed issue shipped and can come back, whereas reopening a dropped issue would carry merged_at NULL into a shipping issue
  it('dropped is terminal with no exit at all', () => {
    expect([...transitions.dropped]).toEqual([]);
  });

  // cm:guard a park resumes onto the LIVE rungs and must include `awaiting_release`: an issue merged and waiting for production, parked and then resumed, must not be forced through `open` — that dispatches a fresh agent onto shipped work and loses its place at the gate. It must NOT offer a retired rung: this row used to be `issueStatuses.filter(...)`, which offered every retired one and is how a resume put work back on a status nothing dispatches at. `developed` and `testing` are LIVE rungs since 2026-09-10 and belong in the first list, not the second.
  it('a park resumes onto a live rung, never a retired one', () => {
    for (const live of [
      'open',
      'in_progress',
      'developed',
      'testing',
      'awaiting_release',
    ] as const) {
      expect(transitions.on_hold, `on_hold → ${live}`).toContain(live);
      expect(transitions.needs_info, `needs_info → ${live}`).toContain(live);
    }
    for (const retired of ['confirmed', 'clarified', 'approved', 'waiting', 'tested'] as const) {
      expect(transitions.on_hold, `on_hold → ${retired}`).not.toContain(retired);
      expect(transitions.needs_info, `needs_info → ${retired}`).not.toContain(retired);
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

  // cm:guard `awaiting_release` does NOT exit to `closed`: the release path closes from `releasing`, where `finish` has read the deploy back. A direct close from the gate is a shipped claim nobody verified — the whole reason the gate exists (release-gate-hold.ts, after epodsystem ISS-141 self-closed with the bug still reproducing).
  it('awaiting_release exits to the release starting, the parks, or a discard', () => {
    expect([...transitions.awaiting_release].sort()).toEqual([
      'dropped',
      'needs_info',
      'on_hold',
      'releasing',
    ]);
  });

  // cm:guard the OUTCOME exits are `finish`'s (`closed`) and `abort`'s (`reopen`) and nothing else may take them — an agent that could leave `releasing` on its own would be declaring its own release finished, which `issues/release-gate-hold.ts` exists to refuse. The two parks are a person stopping to ask, which a half-landed batch needs.
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
    // cm:why these are the pipeline's own rejection paths — the ones that were silently free before ISS-781
    expect(isReopenEntry('developed', 'reopen')).toBe(true);
    expect(isReopenEntry('testing', 'reopen')).toBe(true);
    expect(isReopenEntry('tested', 'reopen')).toBe(true);
    // cm:why negative cases: already at reopen, not heading there at all, or a mechanical revert (ISS-766)
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
      // cm:why ISS-431 — direct-ship: work built outside the pipeline enters AT the review gate, where walking through `open` instead would re-triage it and dispatch an agent onto finished work
      expect(canTransitionFree('draft', 'developed')).toBe(true);
      // cm:why ISS-940 — the rung a session already building the branch takes; promoting instead dispatches a second agent onto the worktree it is in
      expect(canTransitionFree('draft', 'in_progress')).toBe(true);
      expect(canTransitionFree('draft', 'approved')).toBe(false);
      expect(canTransitionFree('draft', 'testing')).toBe(false);
      expect(canTransitionFree('draft', 'awaiting_release')).toBe(false);
    });

    // cm:guard spell the five out LITERALLY on both sides — comparing the computed set against DRAFT_EXIT_TARGETS is tautological, since canTransitionFree reads that same constant, and dropping a member from it passes. Verified 2026-08-27: removing 'dropped' left the tautological form green. The refusal in apply-transition.ts renders this list verbatim, so a silent divergence there is a message that lies about the rule.
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
