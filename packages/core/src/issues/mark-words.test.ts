import { describe, expect, it } from 'vitest';
import { readableThrough } from '../projects/repository-access.js';
import { markStays, movedSentence, notDescendantDetail, unreadAnswer } from './landing-advance.js';
import { describeMergeMark, keptClaimRepeat, markAgainOnce } from './merge-record.js';

// ISS-1421 — every sentence a mark answers a person with: commits in seven characters, at most three
// short sentences (what happened, why, what to do), and the merge Forge saw named once.
const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const B = 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a';
const WHY = `SidCorp-co/forge could not compare ${A} with ${B}: GET /repos/SidCorp-co/forge/compare returned HTTP 502; retry later. The host said more`;
const CLEARS =
  "once the tracker can read the project's repository, through a GitHub binding whose installation can read it";
const NO_READER = `Forge holds no GitHub binding and no deploy key for this project's repository on gitlab.com, so it cannot read the repository — attach a deploy key under Git access`;

function sentences(text: string): number {
  return (text.match(/[.!?](?=\s|$)/g) ?? []).length;
}

function readsShort(text: string): void {
  expect(text).not.toMatch(/[0-9a-f]{40}/i);
  expect(text.match(/Forge saw this merge land/g)?.length ?? 0).toBeLessThanOrEqual(1);
  expect(sentences(text)).toBeLessThanOrEqual(3);
  expect(text).not.toContain('\n');
}

const said: Record<string, string> = {
  observed: describeMergeMark({ kind: 'observed', commitSha: A, claimedCommit: B }),
  'observed from a branch': describeMergeMark({
    kind: 'observed',
    commitSha: A,
    readFrom: { repository: 'SidCorp-co/forge', branch: 'main' },
  }),
  claim: describeMergeMark({ kind: 'asserted', claimedCommit: A }),
  'claim the repository holds': describeMergeMark({
    kind: 'asserted',
    claimedCommit: A,
    claimHeldBy: 'SidCorp-co/forge',
  }),
  'unchecked claim': describeMergeMark({
    kind: 'asserted',
    unverified: { commit: A, why: WHY, clears: CLEARS, noReader: false },
  }),
  'claim with no reader': describeMergeMark({
    kind: 'asserted',
    unverified: { commit: A, why: NO_READER, clears: CLEARS, noReader: true },
  }),
  'kept claim': keptClaimRepeat({ commit: A, why: WHY, clears: CLEARS, noReader: false }),
  'kept claim, another named': keptClaimRepeat({
    commit: A,
    why: WHY,
    clears: CLEARS,
    noReader: false,
    notKept: B,
  }),
  moved: movedSentence(A, B),
  unread: unreadAnswer(A, B, WHY),
  'not a descendant': notDescendantDetail(A, B),
  stays: markStays(null, 'observed', { commitSha: A, landing: null, claimedCommit: null }),
};

describe('the words a mark answers with (ISS-1421)', () => {
  it.each(Object.entries(said))(
    '%s: seven-character commits, three short sentences at most',
    (_, text) => {
      readsShort(text);
    },
  );

  it('cuts another part of Forge to its first clause, shas shortened', () => {
    expect(said.unread).toBe(
      'The mark stays at commit a1b2c3d, and commit b2c3d4e was not compared with it. Forge could not read the repository: SidCorp-co/forge could not compare a1b2c3d with b2c3d4e: GET /repos/SidCorp-co/forge/compare returned HTTP 502. Mark it again once it can.',
    );
  });

  it("says mark it again once Forge can read the repository, for either reader's route", () => {
    for (const route of ['binding', 'deploy_key'] as const) {
      expect(markAgainOnce(readableThrough(route))).toBe(
        'Mark it again once Forge can read the repository',
      );
    }
    expect(markAgainOnce('once the project names its base branch')).toBe(
      'Mark it again once the project names its base branch',
    );
  });

  it('gives a missing reader the setting that clears it, once', () => {
    expect(said['claim with no reader']).toBe(
      "Commit a1b2c3d was named, and is kept as a claim: Forge has no way to read this project's repository, so it did not check it. Attach a deploy key under Git access, then mark it again.",
    );
  });

  it('names a merge Forge saw, and an overruled commit, once each', () => {
    expect(said.observed).toBe(
      'Forge saw this merge land at commit a1b2c3d, in the pull request or the repository. Commit b2c3d4e, named in this mark, is kept as a claim only.',
    );
  });
});
