/**
 * ISS-1126 — the classifier and the sentence, as pure functions (the accepted set per shape is
 * `landing-evidence.test.ts`'s). Criterion 14's runtimes are `merge-mark-route.test.ts` and
 * `mcp/tools/forge-issues-merge-mark.test.ts`; docs/modules/issues/merge-mark.md says why.
 */

import { describe, expect, it } from 'vitest';
import { describeMergeMark, mergeMarkFields, mergeMarkKindOf } from './merge-record.js';

const AT = new Date('2026-09-20T14:59:37.646Z');
const SHA = '9a78b0c93f1a2b3c4d5e6f708192a3b4c5d6e7f8';

const ASSERTED = { mergedAt: AT, mergedCommitSha: null, mergedLanding: null };
const OBSERVED = { mergedAt: AT, mergedCommitSha: SHA, mergedLanding: null };
const UNMARKED = { mergedAt: null, mergedCommitSha: null, mergedLanding: null };
const LANDED = { mergedAt: AT, mergedCommitSha: null, mergedLanding: 'https://shop.example/p/1' };

describe('the mark kind, read off the pair of columns', () => {
  it('reads a mark with no commit as asserted and one with a commit as observed', () => {
    expect(mergeMarkKindOf(ASSERTED)).toBe('asserted');
    expect(mergeMarkKindOf(OBSERVED)).toBe('observed');
    expect(mergeMarkKindOf(UNMARKED)).toBe('unmarked');
  });

  it('reads a mark naming a landing and no commit as landed', () => {
    expect(mergeMarkKindOf(LANDED)).toBe('landed');
    expect(mergeMarkKindOf({ ...LANDED, mergedLanding: '   ' })).toBe('asserted');
    // A commit Forge observed outranks the landing: the column says Forge saw the merge itself.
    expect(mergeMarkKindOf({ ...LANDED, mergedCommitSha: SHA })).toBe('observed');
    // A landing with no timestamp is no mark: `merged_at` decides first.
    expect(mergeMarkKindOf({ ...LANDED, mergedAt: null })).toBe('unmarked');
  });

  it('never calls an asserted mark observed, whatever else is on the row', () => {
    // The rule is `merged_commit_sha`, and nothing else may stand in for it. A reading that fell
    // back to "mergedAt is set, so it landed" is the conflation this whole issue is about.
    expect(mergeMarkKindOf({ ...ASSERTED, mergedCommitSha: null })).not.toBe('observed');
    expect(mergeMarkKindOf({ ...ASSERTED, mergedCommitSha: '' })).not.toBe('observed');
  });

  it('reads an ISO string in the column the same way it reads a Date', () => {
    expect(mergeMarkKindOf({ ...ASSERTED, mergedAt: AT.toISOString() })).toBe('asserted');
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

  it('says an unverified claim is NOT verified, why, and what verifies it, naming the commit once (ISS-1409)', () => {
    const unverified = describeMergeMark({
      kind: 'asserted',
      unverified: { commit: 'abc1234', why: 'attach a deploy key under Git access' },
    });
    expect(unverified).toContain('CLAIM Forge did not observe');
    expect(unverified).toContain('commit abc1234');
    expect(unverified).toContain('NOT verified');
    expect(unverified).toContain('no way to read this project');
    expect(unverified).toContain('attach a deploy key under Git access');
    expect(unverified).toContain('`merged_claimed_commit`');
    expect(unverified).not.toContain('observed.');
    expect(unverified.match(/abc1234/g)).toHaveLength(1);
  });

  it('carries the claim beside the kind, and never lets it make a mark observed (ISS-1409)', () => {
    const row = { ...ASSERTED, mergedClaimedCommit: SHA };
    expect(mergeMarkKindOf(row)).toBe('asserted');
    expect(mergeMarkFields(row)).toMatchObject({ mergeMark: 'asserted', mergedClaimedCommit: SHA });
    expect(mergeMarkFields(ASSERTED).mergedClaimedCommit).toBeNull();
  });

  it('names the landing on a landed mark, and never calls it a merge Forge observed', () => {
    const landed = describeMergeMark({ kind: 'landed', landing: LANDED.mergedLanding });
    expect(landed).toContain(LANDED.mergedLanding);
    expect(landed).toContain('not a merge Forge observed');
  });
});
