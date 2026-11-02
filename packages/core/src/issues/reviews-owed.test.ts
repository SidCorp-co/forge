import { describe, expect, it } from 'vitest';
import type { AuthoredVerdict } from './criteria/live-verdicts.js';
import { unprovenCriteria } from './reviews-owed.js';

// ISS-870: which criteria an independent judge still owes, read by the verified rule.

const AFTER_CUTOVER = '2026-11-01T00:00:00Z';

const v = (verdict: string, over: Partial<AuthoredVerdict> = {}): AuthoredVerdict =>
  ({
    verdict,
    byBuilder: false,
    authored: true,
    recordedAt: AFTER_CUTOVER,
    createdAt: AFTER_CUTOVER,
    ...over,
  }) as AuthoredVerdict;

describe('unprovenCriteria', () => {
  it('owes every criterion no verdict was recorded on', () => {
    expect(unprovenCriteria([1, 2, 3], new Map(), 'independent')).toEqual([1, 2, 3]);
  });

  it("owes a criterion only the builder's own pass stands on, or an unauthored pass", () => {
    const verdicts = new Map([
      [1, [v('pass', { byBuilder: true })]],
      [2, [v('pass', { authored: false })]],
    ]);
    expect(unprovenCriteria([1, 2], verdicts, 'independent')).toEqual([1, 2]);
  });

  it('owes nothing once the judge recorded a pass on each criterion (its review recorded)', () => {
    const verdicts = new Map([
      [1, [v('pass')]],
      [2, [v('pass', { byBuilder: true }), v('pass')]],
    ]);
    expect(unprovenCriteria([1, 2], verdicts, 'independent')).toEqual([]);
  });

  it('still owes a criterion judged short or failed', () => {
    const verdicts = new Map([
      [1, [v('short')]],
      [2, [v('fail')]],
      [3, [v('pass')]],
    ]);
    expect(unprovenCriteria([1, 2, 3], verdicts, 'independent')).toEqual([1, 2]);
  });
});
