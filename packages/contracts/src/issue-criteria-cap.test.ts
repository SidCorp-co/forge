// @direct-test-of packages/contracts/src/issue-design.ts
// @direct-test-of packages/contracts/src/issue-review.ts
// ISS-837: a design and a review name one line per criterion, so each takes as many lines as an
// issue holds criteria. adminhub-api ISS-78 holds 71, and a cap of 50 left it no design it could
// write, so gate design_record could never pass.
import { describe, expect, it } from 'vitest';
import { ISSUE_CRITERIA_MAX, recordDesignRequestSchema } from './issue-design.js';
import { recordReviewRequestSchema } from './issue-review.js';

const designLines = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    criterion: i + 1,
    class: 'observable' as const,
    pattern: null,
    proof: `probe ${i + 1}`,
  }));

const reviewLines = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    criterion: i + 1,
    result: 'pass' as const,
    reason: 'held in the diff',
    evidence: ['packages/core/src/x.ts'],
  }));

const sha = 'a'.repeat(40);

describe('an issue with more than 50 criteria', () => {
  it('records a design naming every one of its 71 criteria', () => {
    const body = { criteria: designLines(71), modules: [], contracts: [] };
    expect(recordDesignRequestSchema.safeParse(body).success).toBe(true);
  });

  it('records a review naming every one of its 71 criteria', () => {
    const body = { base: sha, head: sha, checklist: [], criteria: reviewLines(71) };
    expect(recordReviewRequestSchema.safeParse(body).success).toBe(true);
  });

  it('takes a design and a review up to the issue limit, and refuses past it', () => {
    const design = (n: number) =>
      recordDesignRequestSchema.safeParse({ criteria: designLines(n), modules: [], contracts: [] })
        .success;
    const review = (n: number) =>
      recordReviewRequestSchema.safeParse({
        base: sha,
        head: sha,
        checklist: [],
        criteria: reviewLines(n),
      }).success;
    expect([design(ISSUE_CRITERIA_MAX), review(ISSUE_CRITERIA_MAX)]).toEqual([true, true]);
    expect([design(ISSUE_CRITERIA_MAX + 1), review(ISSUE_CRITERIA_MAX + 1)]).toEqual([false, false]);
  });
});
