import { describe, expect, it } from 'vitest';
import { masterWork, owedLine, workDigest } from './owed.js';
import type { ReviewOwed } from './ports.js';

// ISS-870 (FB-433): a review an independent judge owes is master work, counted, named and digested
// like every other owed item, so the verdict that reads `owed` places a master for it.

const none: Parameters<typeof owedLine>[0] = {
  designs: [],
  revisions: [],
  breakdowns: [],
  triages: [],
  confirms: [],
  comments: [],
  documents: [],
  builderRuns: [],
  releaseNotes: [],
  warnedNotes: [],
  unnamedReleases: [],
  releaseMerges: [],
  releaseApprovals: [],
  releaseActs: [],
  answers: [],
  stewardAsks: [],
  questions: [],
  landedWork: [],
  marks: [],
  filings: [],
  recordings: [],
  releaseHolds: [],
  endedRunHolds: [],
  requests: [],
  carriers: [],
  reviews: [],
  contentLanguage: 'en',
};

const review = (over: Partial<ReviewOwed> = {}): ReviewOwed => ({
  issueId: 'i-10',
  key: 'ISS-10',
  status: 'awaiting_release',
  criteria: [1, 2, 3],
  ...over,
});

describe('ISS-870: the reviews an independent judge owes', () => {
  it('counts a review owed as master work, so a project owing only that is not read as owing nothing', () => {
    expect(masterWork([], none, 'dispatch').owed).toBe(0);
    const work = masterWork([], { ...none, reviews: [review()] }, 'dispatch');
    expect(work.owed).toBe(1);
    expect(work.admissible).toBe(0);
  });

  it('names each issue, where it stands, and the criteria its judge owes, with the guide that is how', () => {
    const line = owedLine({
      ...none,
      reviews: [
        review(),
        review({ issueId: 'i-11', key: 'ISS-11', status: 'in_progress', criteria: [2] }),
      ],
    });
    expect(line).toContain(
      '2 issues owe an independent review (ISS-10 i-10 at `awaiting_release`, criteria 1, 2, 3; ISS-11 i-11 at `in_progress`, its test step, criterion 2)',
    );
    expect(line).toContain('gate independent_qa');
    expect(line).toContain('`--role qa`');
    expect(line).toContain('`--role reviewer`');
    expect(line).toContain('`forge-runner api guides/qa.md` is how');
    expect(masterWork([], { ...none, reviews: [review()] }, 'dispatch').nudge).toContain(
      '1 issue owes an independent review (ISS-10',
    );
  });

  it('says nothing where no review is owed', () => {
    expect(owedLine(none)).toBe('');
  });

  it('moves the digest when a criterion is judged, and not when nothing changed', () => {
    const before = workDigest([], { ...none, reviews: [review()] });
    expect(workDigest([], { ...none, reviews: [review()] })).toBe(before);
    expect(workDigest([], { ...none, reviews: [review({ criteria: [2, 3] })] })).not.toBe(before);
    expect(workDigest([], none)).not.toBe(before);
  });
});
