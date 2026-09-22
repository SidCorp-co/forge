/**
 * ISS-1126 — an asserted mark and an observed mark are told apart by every surface that reports one.
 *
 * The property under test is not "the field is present": it is that the two states produce
 * DIFFERENT answers. A test that only asserted a key exists stays green through the defect this
 * issue is about, which is a system where both states are reachable and every reader reports them
 * alike. So each case here builds one of each and asserts the pair differs, and the assertion names
 * the surface it holds.
 *
 * The observed row is built by hand rather than by merging something, because `observedMergeForIssue`
 * cannot return a row on a database whose projection nothing has written to. That is the whole
 * reason this file exists: the branch is unreachable in the field and so is only ever exercised
 * here.
 */

import { describe, expect, it } from 'vitest';
import { MARKS_ACCEPTED_AS_LANDED, mergedMarkShortfall } from './entry-criteria-merge-mark.js';
import { describeMergeMark, mergeMarkKindOf } from './merge-record.js';

const AT = new Date('2026-09-20T14:59:37.646Z');
const SHA = '9a78b0c93f1a2b3c4d5e6f708192a3b4c5d6e7f8';

const ASSERTED = { mergedAt: AT, mergedCommitSha: null };
const OBSERVED = { mergedAt: AT, mergedCommitSha: SHA };
const UNMARKED = { mergedAt: null, mergedCommitSha: null };

describe('the mark kind, read off the pair of columns', () => {
  it('reads a mark with no commit as asserted and one with a commit as observed', () => {
    expect(mergeMarkKindOf(ASSERTED)).toBe('asserted');
    expect(mergeMarkKindOf(OBSERVED)).toBe('observed');
    expect(mergeMarkKindOf(UNMARKED)).toBe('unmarked');
  });

  it('never calls an asserted mark observed, whatever else is on the row', () => {
    // The rule is `merged_commit_sha`, and nothing else may stand in for it. A reading that fell
    // back to "mergedAt is set, so it landed" is the conflation this whole issue is about.
    expect(mergeMarkKindOf({ mergedAt: AT, mergedCommitSha: null })).not.toBe('observed');
    expect(mergeMarkKindOf({ mergedAt: AT, mergedCommitSha: '' })).not.toBe('observed');
  });

  it('reads an ISO string in the column the same way it reads a Date', () => {
    expect(mergeMarkKindOf({ mergedAt: AT.toISOString(), mergedCommitSha: null })).toBe('asserted');
  });
});

describe('the sentence a caller is given', () => {
  const asserted = describeMergeMark({ kind: 'asserted', claimedCommit: 'abc1234' });
  const assertedBare = describeMergeMark({ kind: 'asserted' });
  const observed = describeMergeMark({ kind: 'observed', commitSha: SHA });

  it('says CLAIM for a mark Forge did not observe, with or without a claimed commit', () => {
    expect(asserted).toContain('CLAIM Forge did not observe');
    expect(assertedBare).toContain('CLAIM Forge did not observe');
  });

  it('tells a caller that named a commit that its commit is not in the column', () => {
    expect(asserted).toContain('abc1234');
    expect(asserted).toContain('NOT in `merged_commit_sha`');
  });

  it('gives the observed mark a different sentence from the asserted one', () => {
    expect(observed).not.toBe(asserted);
    expect(observed).not.toContain('CLAIM Forge did not observe');
    expect(observed).toContain(SHA);
  });
});

describe('the reader that means shipped says which kinds it accepts', () => {
  it('names its accepted set rather than testing `mergedAt` for null', () => {
    expect([...MARKS_ACCEPTED_AS_LANDED].sort()).toEqual(['asserted', 'observed']);
  });

  it('accepts both kinds of mark and refuses an issue with none', () => {
    expect(mergedMarkShortfall(ASSERTED)).toBeNull();
    expect(mergedMarkShortfall(OBSERVED)).toBeNull();
    expect(mergedMarkShortfall(UNMARKED)).not.toBeNull();
  });

  it('names the kinds that would have satisfied it when it refuses', () => {
    const detail = mergedMarkShortfall(UNMARKED) as string;
    for (const kind of MARKS_ACCEPTED_AS_LANDED) expect(detail).toContain(kind);
  });

  it('is gated on membership of the set, so narrowing the set changes what it accepts', () => {
    // The amnesty this constant prices is that an asserted mark counts as landed. The proof that it
    // is priced ON THE CONSTANT rather than decorated by it is that removing a kind from the set
    // has to refuse that kind. A predicate that ignored the set would stay green here.
    expect(mergedMarkShortfall(ASSERTED, ['observed'])).not.toBeNull();
    expect(mergedMarkShortfall(OBSERVED, ['observed'])).toBeNull();
  });
});
