/**
 * ISS-1073 — the decision table, one case per way a merge is refused.
 *
 * Table-driven on purpose: the property is that every input that is not the one
 * positive condition produces a refusal, and a suite written case-by-case grows
 * a gap the first time somebody adds a `mergeable_state`. The assertions are on
 * the REASON and on the sentence naming what is wrong, because "cannot merge"
 * sends an operator to look and these four causes send them to four different
 * places.
 */

import { describe, expect, it } from 'vitest';
import {
  decideMerge,
  type HeadCheck,
  type MergeReadout,
  type ProtectionReadout,
} from './merge-eligibility.js';

const HEAD = 'c0ffee1234567890c0ffee1234567890c0ffee12';

const open = (over: Partial<MergeReadout> = {}): MergeReadout => ({
  number: 481,
  state: 'open',
  draft: false,
  merged: false,
  mergeCommitSha: null,
  mergedAt: null,
  headSha: HEAD,
  baseRef: 'main',
  mergeable: true,
  mergeableState: 'clean',
  ...over,
});

const PROTECTED: ProtectionReadout = { kind: 'protected', requiredChecks: ['ci-passed'] };
const UNPROTECTED: ProtectionReadout = { kind: 'unprotected' };
const GREEN: HeadCheck[] = [{ name: 'ci-passed', status: 'completed', conclusion: 'success' }];

const decide = (
  pull: MergeReadout,
  protection: ProtectionReadout = PROTECTED,
  headChecks: readonly HeadCheck[] = GREEN,
  expectedHeadSha?: string,
) => decideMerge({ pull, protection, headChecks, ...(expectedHeadSha ? { expectedHeadSha } : {}) });

describe('the one condition that merges', () => {
  it('merges a clean, mergeable pull request whose required checks all passed', () => {
    expect(decide(open())).toEqual({ kind: 'merge' });
  });

  it('merges when only NON-required checks are failing (`unstable`)', () => {
    const checks = [...GREEN, { name: 'lint', status: 'completed', conclusion: 'failure' }];
    expect(decide(open({ mergeableState: 'unstable' }), PROTECTED, checks)).toEqual({
      kind: 'merge',
    });
  });

  it('merges on an unprotected base, where nothing is required', () => {
    expect(decide(open(), UNPROTECTED, [])).toEqual({ kind: 'merge' });
  });
});

describe('a merge GitHub has already made', () => {
  it('answers already-merged rather than refusing', () => {
    expect(decide(open({ merged: true, state: 'closed' }))).toEqual({ kind: 'already-merged' });
  });
});

describe('each refusal names what is wrong', () => {
  // cm:guard this is the planted set for criteria 13, 14, 15, 16, 17 and 19. Each row is an input the merge path must NOT take, and the reason is asserted rather than the fact of refusal: collapse any two of these into one sentence and the row naming the other goes red.
  const cases: Array<{
    what: string;
    pull: MergeReadout;
    protection?: ProtectionReadout;
    checks?: HeadCheck[];
    expectedHeadSha?: string;
    reason: string;
    says: RegExp;
  }> = [
    {
      what: 'a conflict with the base',
      pull: open({ mergeable: false, mergeableState: 'dirty' }),
      reason: 'conflicting',
      says: /conflicts with `main`/,
    },
    {
      what: 'a head behind a base that requires being up to date',
      pull: open({ mergeableState: 'behind' }),
      reason: 'behind',
      says: /is behind `main`/,
    },
    {
      what: 'a required check that has not concluded',
      pull: open(),
      checks: [{ name: 'ci-passed', status: 'in_progress', conclusion: null }],
      reason: 'required-check',
      says: /requires the check `ci-passed` and it is still in_progress/,
    },
    {
      what: 'a required check that failed',
      pull: open(),
      checks: [{ name: 'ci-passed', status: 'completed', conclusion: 'failure' }],
      reason: 'required-check',
      says: /requires the check `ci-passed` and it concluded `failure`/,
    },
    {
      what: 'a required check nothing has reported at all',
      pull: open(),
      checks: [],
      reason: 'required-check',
      says: /nothing has reported it on this head/,
    },
    {
      what: 'a protection that is not a check',
      pull: open({ mergeableState: 'blocked' }),
      reason: 'protected-branch',
      says: /will not bypass the protection/,
    },
    {
      what: 'a mergeability GitHub has not computed',
      pull: open({ mergeable: null, mergeableState: 'unknown' }),
      reason: 'mergeability-uncomputed',
      says: /not a no, and Forge will not read it as a yes/,
    },
    {
      what: 'a mergeability field GitHub sent nothing for',
      pull: open({ mergeable: null, mergeableState: null }),
      reason: 'mergeability-uncomputed',
      says: /has not finished computing/,
    },
    {
      what: 'a protection Forge cannot read',
      pull: open(),
      protection: { kind: 'unreadable', why: 'HTTP 403' },
      reason: 'protection-unreadable',
      says: /cannot tell a satisfied protection from an unsatisfied one/,
    },
    {
      what: 'a draft',
      pull: open({ draft: true }),
      reason: 'draft',
      says: /mark it ready for review/,
    },
    {
      what: 'a pull request closed without merging',
      pull: open({ state: 'closed' }),
      reason: 'not-open',
      says: /was never merged/,
    },
    {
      what: 'a head that moved since the merge was authorised',
      pull: open(),
      expectedHeadSha: 'deadbeef00000000000000000000000000000000',
      reason: 'head-moved',
      says: /the commits this would land are not the ones that were judged/,
    },
  ];

  it.each(cases)('refuses $what by name', (c) => {
    const decision = decide(
      c.pull,
      c.protection ?? PROTECTED,
      c.checks ?? GREEN,
      c.expectedHeadSha,
    );
    expect(decision.kind).toBe('refuse');
    if (decision.kind !== 'refuse') return;
    expect(decision.reason).toBe(c.reason);
    expect(decision.detail).toMatch(c.says);
  });

  // cm:guard uncomputed mergeability is checked BEFORE any state-derived answer, and this pins the order: a `null` mergeable arriving with a `dirty` state must still read as uncomputed, because GitHub's first answer after a push carries a stale state beside an uncomputed flag.
  it('reads an uncomputed mergeability as uncomputed even beside a state that looks decisive', () => {
    const decision = decide(open({ mergeable: null, mergeableState: 'unknown' }));
    expect(decision.kind === 'refuse' && decision.reason).toBe('mergeability-uncomputed');
  });
});
