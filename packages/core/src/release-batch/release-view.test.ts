// REQ-35 BC-9: a release shows each requirement as a bar of criteria passed. The bar needs the
// requirement's total, and before ISS-463 `completionOf` carried only the codes this release moves
// and the codes still owed, so no page could draw passed out of the total. These read the counts
// off the same coverage the requirement page reads, and watch one verdict move them.

import type { BcVerdict } from '@forge/contracts/requirements';
import { describe, expect, it } from 'vitest';
import { type CompletionFacts, completionOf } from './release-view.js';

const IN_RELEASE = new Set(['i1']);

function requirement(verdicts: readonly BcVerdict[]): CompletionFacts {
  return {
    key: 'REQ-1',
    title: 'A requirement',
    status: 'agreed',
    state: 'in_delivery',
    coverage: verdicts.map((verdict, i) => ({
      code: `BC-${i + 1}`,
      verdict,
      issues: verdict === 'gap' ? [] : [{ issueId: 'i1', criterion: i + 1, stale: false }],
    })),
    live: [{ id: 'i1', key: 'ISS-1', status: 'awaiting_release' }],
  };
}

describe('a release requirement is counted out of its own criteria', () => {
  it('carries every criterion of the requirement as the total, not only the ones this release moves', () => {
    const view = completionOf(
      requirement(['passing', 'failing', 'not_judged', 'stale', 'gap']),
      IN_RELEASE,
    );
    expect(view.coverage).toEqual({ criteria: 5, passing: 1, judged: 2 });
    expect(view.advances).toHaveLength(4);
  });

  it('grows passing by one, and only that, when one criterion moves from not judged to pass', () => {
    const before = completionOf(requirement(['passing', 'not_judged', 'not_judged']), IN_RELEASE);
    const after = completionOf(requirement(['passing', 'passing', 'not_judged']), IN_RELEASE);
    expect(before.coverage).toEqual({ criteria: 3, passing: 1, judged: 1 });
    expect(after.coverage).toEqual({ criteria: 3, passing: 2, judged: 2 });
    expect(after.coverage.passing - before.coverage.passing).toBe(1);
    expect(after.coverage.criteria).toBe(before.coverage.criteria);
  });

  it('reads a requirement with no criteria as an empty whole, and completes nothing', () => {
    const view = completionOf(requirement([]), IN_RELEASE);
    expect(view.coverage).toEqual({ criteria: 0, passing: 0, judged: 0 });
    expect(view.completes).toBe(false);
  });

  it('agrees with the remaining codes: what is not passing is the total less the passing', () => {
    const view = completionOf(
      requirement(['passing', 'failing', 'gap', 'passing', 'not_judged']),
      IN_RELEASE,
    );
    expect(view.coverage.criteria - view.coverage.passing).toBe(view.remaining.criteria.length);
  });
});
