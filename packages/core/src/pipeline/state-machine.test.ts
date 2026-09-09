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

  it('on_hold can resume to any non-on_hold, non-draft status', () => {
    // cm:why ISS-236 — `draft` is excluded from the resume list because nothing may be demoted INTO draft, not because on_hold is special
    const resumable = issueStatuses.filter((s) => s !== 'on_hold' && s !== 'draft');
    expect([...transitions.on_hold]).toEqual(resumable);
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

  it('released exits to the close, the release starting, or a pause', () => {
    expect([...transitions.released].sort()).toEqual(['closed', 'on_hold', 'releasing']);
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
      expect(canTransitionFree('open', 'released')).toBe(true);
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
      expect(canTransitionFree('draft', 'released')).toBe(false);
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
