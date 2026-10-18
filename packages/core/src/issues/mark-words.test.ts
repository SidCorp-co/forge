import { describe, expect, it } from 'vitest';
import { readableThrough } from '../projects/repository-access.js';
import { markStays, movedSentence, notDescendantDetail, unreadAnswer } from './landing-advance.js';
import {
  addressesAsCode,
  describeMergeMark,
  keptClaimRepeat,
  markAgainOnce,
} from './merge-record.js';

// ISS-1421 — every sentence a mark answers a person with: commits in seven characters, at most three
// short sentences (what happened, why, what to do), each capitalised, stopped and at most 20 words,
// another part of Forge's reason quoted on a line of its own (criteria 63, 117, 119).
const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const B = 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a';
const WHY = `SidCorp-co/forge could not compare ${A} with ${B}: GET /repos/SidCorp-co/forge/compare returned HTTP 502; retry later. The host said more`;
const CLEARS =
  "once the tracker can read the project's repository, through a GitHub binding whose installation can read it";
const NO_READER = `Forge holds no GitHub binding and no deploy key for this project's repository on gitlab.com, so it cannot read the repository — attach a deploy key with write access to git@gitlab.com:acme/shop.git under Git access`;
const REPO = 'git@github.com:junixlabs/PixelAgent.git';

/** Our own sentences, the quoted lines set apart. */
function split(text: string): { ours: string[]; quotes: string[] } {
  const lines = text.split('\n');
  const quotes = lines.filter((l) => l.startsWith('> '));
  const ours = lines
    .filter((l) => !l.startsWith('> '))
    .join(' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z])/);
  return { ours, quotes };
}

function readsShort(text: string): void {
  const { ours, quotes } = split(text);
  expect(ours.join(' ')).not.toMatch(/[0-9a-f]{40}/i);
  expect(text.match(/Forge saw this merge land/g)?.length ?? 0).toBeLessThanOrEqual(1);
  expect(ours.length).toBeLessThanOrEqual(3);
  for (const sentence of ours) {
    expect(sentence, sentence).toMatch(/^[A-Z]/);
    expect(sentence, sentence).toMatch(/\.$/);
    expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(20);
  }
  expect(quotes.length).toBeLessThanOrEqual(1);
  for (const quote of quotes) {
    expect(quote).not.toMatch(/[0-9a-f]{40}/i);
    // Another part's words still stop, and open capitalised unless they open on an address.
    expect(quote, quote).toMatch(/[.!?]$/);
    expect(quote, quote).toMatch(/^> (?:[A-Z]|\S*[@/:])/);
  }
}

const said: Record<string, string> = {
  observed: describeMergeMark({ kind: 'observed', commitSha: A, claimedCommit: B }),
  'observed from a branch': describeMergeMark({
    kind: 'observed',
    commitSha: A,
    readFrom: { repository: REPO, branch: 'main' },
  }),
  claim: describeMergeMark({ kind: 'asserted', claimedCommit: A }),
  'claim the repository holds': describeMergeMark({
    kind: 'asserted',
    claimedCommit: A,
    claimHeldBy: REPO,
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
  unread: unreadAnswer(`The mark stays at commit ${A.slice(0, 7)}.`, B, WHY),
  'unread, no reader': unreadAnswer('The mark stays a claim that names no commit.', B, NO_READER),
  'not a descendant': notDescendantDetail(A, B),
  stays: markStays(null, 'observed', { commitSha: A, landing: null, claimedCommit: null }),
  'no commit named': describeMergeMark({ kind: 'asserted' }),
};

describe('the words a mark answers with (ISS-1421)', () => {
  it.each(Object.entries(said))(
    '%s: seven-character commits, three short capitalised sentences, a reason quoted apart',
    (_, text) => {
      readsShort(text);
    },
  );

  it('says where the mark stays when a commit cannot be checked, and quotes why beneath', () => {
    expect(said.unread).toBe(
      'The mark stays at commit a1b2c3d. Forge could not check commit b2c3d4e against the repository. Mark it again once it can.\n' +
        '> SidCorp-co/forge could not compare a1b2c3d with b2c3d4e: GET /repos/SidCorp-co/forge/compare returned HTTP 502; retry later. The host said more.',
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

  it('gives a missing reader its two settings in our words, and the host its own line', () => {
    expect(said['claim with no reader']).toBe(
      "Commit a1b2c3d was named and is kept as a claim. Forge has no way to read this project's repository, so it did not check it. Attach a deploy key, then mark it again.\n" +
        `> ${NO_READER}.`,
    );
  });

  it('names a merge Forge saw once, and says an overruled commit was not recorded', () => {
    expect(said.observed).toBe(
      'Forge saw this merge land at commit a1b2c3d, in the pull request or the repository. Commit b2c3d4e, named in this mark, was not recorded.',
    );
  });

  // r8, criteria 121 and 122: the row keeps no commit a person names, so no answer says it is kept.
  it("says a person's commit is noted in the comment only, as the row and a repeat say", () => {
    expect(said['claim the repository holds']).toBe(
      `Commit a1b2c3d is in ${REPO}, and is noted in the comment only. Forge did not see this merge, so the mark is a claim that names no commit.`,
    );
    expect(said['claim the repository holds']).not.toContain('kept');
    expect(
      markStays(null, 'asserted', { commitSha: null, landing: null, claimedCommit: null }),
    ).toBe('The mark stays a claim that names no commit.');
  });

  // r8, criterion 125: judge-40 saw git@github.com rendered as a mail link in the thread.
  it('shows a repository address as code in a comment, and leaves code and plain words alone', () => {
    expect(addressesAsCode(`Commit a1b2c3d is in ${REPO}, and is noted.`)).toBe(
      `Commit a1b2c3d is in \`${REPO}\`, and is noted.`,
    );
    expect(addressesAsCode('on main of https://github.com/SidCorp-co/forge.git.')).toBe(
      'on main of `https://github.com/SidCorp-co/forge.git`.',
    );
    expect(addressesAsCode(`already \`${REPO}\` here`)).toBe(`already \`${REPO}\` here`);
    expect(addressesAsCode('on main of SidCorp-co/forge.')).toBe('on main of SidCorp-co/forge.');
  });
});
