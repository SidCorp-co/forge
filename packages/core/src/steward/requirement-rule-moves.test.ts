// REQ-74 BC-8 (ISS-1155): a requirement moves by rule to in delivery once one of its issues started,
// to delivered once every criterion of its current revision passes, and to accepted at delivered where
// no person accept gate asks it; each move records the rule and the passing count it read.
// @direct-test-of packages/core/src/steward/requirement-rule-moves.ts

import { describe, expect, it } from 'vitest';
import { ruleMoveOf, ruleReason } from './requirement-rule-moves.js';

type At = Parameters<typeof ruleMoveOf>[0];
const at = (state: string, startedIssues: number, passing: number, criteria: number): At =>
  ({
    state,
    delivery: { startedIssues, criteriaCoverage: { passing, criteria } },
  }) as unknown as At;

describe("a requirement's moves by rule", () => {
  it('moves agreed into delivery once one of its issues started, and not before', () => {
    expect(ruleMoveOf(at('agreed', 1, 0, 3))).toBe('in_delivery');
    expect(ruleMoveOf(at('agreed', 0, 0, 3))).toBeNull();
    expect(ruleReason('in_delivery', at('agreed', 2, 0, 3))).toBe(
      'by rule: 2 of its issues started, and no person gate asks this move',
    );
  });

  it('marks it delivered once every criterion of the current revision passes, never with one short or none', () => {
    expect(ruleMoveOf(at('in_delivery', 1, 3, 3))).toBe('delivered');
    expect(ruleMoveOf(at('in_delivery', 1, 2, 3))).toBeNull();
    expect(ruleMoveOf(at('in_delivery', 1, 0, 0))).toBeNull();
    expect(ruleReason('delivered', at('in_delivery', 1, 3, 3))).toBe(
      'by rule: 3/3 criteria passing on the current revision',
    );
  });

  it('accepts it at delivered, naming the rule and its passing count', () => {
    expect(ruleMoveOf(at('delivered', 1, 3, 3))).toBe('accepted');
    expect(ruleMoveOf(at('delivered', 1, 2, 3))).toBeNull();
    expect(ruleReason('accepted', at('delivered', 1, 3, 3))).toBe(
      'accepted by rule: no person accept gate on this project, 3/3 criteria passing',
    );
  });

  it('moves nothing already accepted, and nothing not yet agreed', () => {
    expect(ruleMoveOf(at('accepted', 1, 3, 3))).toBeNull();
    expect(ruleMoveOf(at('draft', 1, 3, 3))).toBeNull();
  });
});
