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

  it('says a mark Forge did not see is a claim, with or without a commit named', () => {
    expect(assertedBare).toBe(
      'No commit was named. Forge did not see this merge, so the mark is a claim.',
    );
    expect(asserted).toContain('Forge did not see this merge');
  });

  it('tells a caller that named a commit that its commit is kept as a claim, not as the merge commit', () => {
    expect(asserted).toContain('Commit abc1234 was named, and is kept as a claim.');
    expect(asserted).toContain('so it is not the merge commit');
  });

  it('gives the observed mark a different sentence from the asserted one', () => {
    expect(observed).not.toBe(asserted);
    expect(observed).not.toContain('a claim');
    expect(observed).toContain(`Forge saw this merge land at commit ${SHA}.`);
  });

  it('says an unchecked claim was not checked, why, and what checks it, naming the commit once (ISS-1409)', () => {
    const unverified = describeMergeMark({
      kind: 'asserted',
      unverified: {
        commit: 'abc1234',
        why: 'attach a deploy key under Git access',
        clears: 'once a deploy key is attached',
        noReader: true,
      },
    });
    expect(unverified).toContain('Commit abc1234 was named, and is kept as a claim.');
    expect(unverified).toContain(
      "Forge has no way to read this project's repository, so it did not check it.",
    );
    expect(unverified).toContain(
      'To have it checked, attach a deploy key under Git access, then mark it again.',
    );
    expect(unverified.match(/abc1234/g)).toHaveLength(1);
  });

  it('names the host\'s own words and the fix where a configured reader failed, never "no way to read" (ISS-1409)', () => {
    const failed = describeMergeMark({
      kind: 'asserted',
      unverified: {
        commit: 'abc1234',
        why: 'the git host refused the deploy key attached to this project',
        clears: "once the tracker can read the project's repository with the deploy key",
        noReader: false,
      },
    });
    expect(failed).toContain(
      'Forge could not check it: the git host refused the deploy key attached to this project.',
    );
    expect(failed).toContain(
      "To have it checked, mark it again once the tracker can read the project's repository with the deploy key.",
    );
    expect(failed).not.toContain('no way to read');
  });

  it("says by name that a repeat's other commit was not recorded, and the first claim stands (ISS-1409)", () => {
    const repeat = describeMergeMark({
      kind: 'asserted',
      unverified: { commit: 'abc1234', why: 'w', clears: 'c', noReader: true, notKept: 'def5678' },
    });
    expect(repeat).toContain('Commit def5678 was not recorded: the first claim, abc1234, stands.');
    expect(repeat).toContain('To change it, Unmark, then Mark merged again.');
  });

  it('carries the claim beside the kind, and never lets it make a mark observed (ISS-1409)', () => {
    const row = { ...ASSERTED, mergedClaimedCommit: SHA };
    expect(mergeMarkKindOf(row)).toBe('asserted');
    expect(mergeMarkFields(row)).toMatchObject({ mergeMark: 'asserted', mergedClaimedCommit: SHA });
    expect(mergeMarkFields(ASSERTED).mergedClaimedCommit).toBeNull();
  });

  it('names the landing on a landed mark, and never says Forge saw it land', () => {
    const landed = describeMergeMark({ kind: 'landed', landing: LANDED.mergedLanding });
    expect(landed).toContain(LANDED.mergedLanding);
    expect(landed).toContain('Forge did not see it land');
  });
});

// ISS-1421 r4 — the mark's sentence is the comment a person reads on the issue: judge-32 found
// `merged_commit_sha` in it. Every kind, and every branch inside one, speaks of the merge in words.
describe('the mark sentence names no stored field (ISS-1421 r4)', () => {
  const STORED = /merged_(at|commit_sha|landing|claimed_commit)|\bcolumn\b|`(un)?mark`/;
  const said = [
    describeMergeMark({ kind: 'unmarked' }),
    describeMergeMark({ kind: 'landed', landing: LANDED.mergedLanding }),
    describeMergeMark({ kind: 'observed', commitSha: SHA }),
    describeMergeMark({ kind: 'observed', commitSha: SHA, claimedCommit: 'abc1234' }),
    describeMergeMark({ kind: 'asserted' }),
    describeMergeMark({ kind: 'asserted', claimedCommit: 'abc1234', claimHeldBy: 'acme/shop' }),
    describeMergeMark({
      kind: 'asserted',
      unverified: { commit: 'abc1234', why: 'w', clears: 'c', noReader: true, notKept: 'def5678' },
    }),
  ];

  it.each(said.map((sentence, i) => [i, sentence] as const))('sentence %i', (_, sentence) => {
    expect(sentence).not.toMatch(STORED);
  });

  // Repair 1 — a person reads these in the thread: plain short sentences, nothing shouted.
  it.each(said.map((sentence, i) => [i, sentence] as const))(
    'sentence %i is short plain sentences',
    (_, sentence) => {
      expect(sentence).toMatch(/^[A-Z].*\.$/s);
      expect(sentence).not.toMatch(/\b[A-Z]{3,}\b/);
      for (const one of sentence.split(/(?<=[.:])\s+(?=[A-Z])/)) {
        expect(one.split(/\s+/).length, one).toBeLessThanOrEqual(20);
      }
    },
  );

  it('a sentence naming a stored field is caught', () => {
    expect('`merged_commit_sha` holds abc').toMatch(STORED);
  });
});
