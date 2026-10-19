import { describe, expect, it } from 'vitest';
import { noWorkEvidenceDetail } from '../pipeline/work-evidence.js';
import { readableThrough } from '../projects/repository-access.js';
import { markStays, movedSentence, notDescendantDetail, unreadAnswer } from './landing-advance.js';
import { type Lane, landingMarkRefusal, type MarkDoor } from './landing-evidence.js';
import { targetRequiredDetail } from './merge-input-refusal.js';
import {
  addressesAsCode,
  describeMergeMark,
  keptClaimRepeat,
  markAgainOnce,
  threadBody,
  withReason,
} from './merge-record.js';

// ISS-1421 — every sentence a mark answers a person with: commits in seven characters, at most three
// short sentences (what happened, why, what to do), each capitalised, stopped and at most 20 words,
// another part of Forge's reason quoted on a line of its own (criteria 63, 117, 119).
const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const B = 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a';
const WHY = `SidCorp-co/forge could not compare ${A} with ${B}: GET /repos/SidCorp-co/forge/compare returned HTTP 502; retry later. The host said more`;
const CLEARS =
  "once the tracker can read the project's repository, through a GitHub binding whose installation can read it";
const NO_READER = `Forge holds no GitHub binding and no deploy key for this project's repository on gitlab.com, so it cannot read the repository — attach a deploy key with read access to git@gitlab.com:acme/shop.git under Git access`;
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

  // r9, criterion 125: judge-43 saw the host's own reason keep `git@github.com:` bare, a mail link.
  it('shows the address inside a quoted host reason as code too, whatever follows it', () => {
    expect(addressesAsCode('> (git@github.com: Permission denied (publickey).)')).toBe(
      '> (`git@github.com`: Permission denied (publickey).)',
    );
    expect(addressesAsCode('Host git@gitlab.com refused.')).toBe('Host `git@gitlab.com` refused.');
    expect(addressesAsCode('at git@github.com:acme/shop.git: no key')).toBe(
      'at `git@github.com:acme/shop.git`: no key',
    );
  });

  // r9: judge-43 saw a first mark run its note into the opening line, where a repeat quotes it.
  it("quotes a first mark's note, and an unmark's, on a line of its own as a repeat does", () => {
    const stamp = {
      wrote: true,
      mergedAt: new Date('2026-10-18T00:00:00Z'),
      commitSha: null,
      landing: null,
      claimedCommit: null,
    };
    const base = { stamp, claimedCommit: null, unread: null, after: '' };
    const note = 'Merged by hand after CI went green.';
    const first = threadBody({
      ...base,
      op: 'mark',
      target: 'main',
      note,
      repeated: false,
      markDetail: describeMergeMark({ kind: 'asserted' }),
    });
    expect(first).toBe(
      'Marked merged into main.\nNo commit was named. Forge did not see this merge, so the mark is a claim.' +
        `\n\n> ${note}`,
    );
    const unmark = threadBody({ ...base, op: 'unmark', note, repeated: false, markDetail: '' });
    expect(unmark).toBe(`Merge mark removed.\n\n> ${note}`);
    expect(threadBody({ ...base, op: 'unmark', repeated: false, markDetail: '' })).toBe(
      'Merge mark removed.',
    );
  });
});

// r9, criteria 63, 119 and 131: judge-43 read LANDING_REQUIRED and NO_WORK_EVIDENCE in four
// sentences with stored keys, a REST caller told to use MCP's words, and a missing target answered
// "Invalid input". Each mark refusal is at most three short sentences, naming its own door's field.
describe("a mark's refusals, at each door (ISS-1421 r9)", () => {
  const git: Lane = { shape: 'git', declared: false };
  const outside: Lane = { shape: 'outside_git', declared: true };
  const doors: MarkDoor[] = ['rest', 'mcp'];

  function ownWords(text: string): string[] {
    return text
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.startsWith('> '))
      .join(' ')
      .trim()
      .split(/(?<=[.!?])\s+(?=[A-Z])/);
  }

  function refusalReads(text: string, door: MarkDoor): void {
    const ours = ownWords(text);
    expect(ours.length, text).toBeLessThanOrEqual(3);
    for (const sentence of ours) {
      expect(sentence, sentence).toMatch(/^[A-Z]/);
      expect(sentence, sentence).toMatch(/\.$/);
      expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(20);
      expect(sentence, sentence).not.toMatch(/landingShape|mark_merged|forge_issues/);
    }
    // Each door names the field its own caller sends, and never the other door's.
    const own = ours.join(' ');
    if (door === 'rest') expect(own, own).not.toContain('data.');
    if (door === 'mcp') expect(own, own).not.toMatch(/`(?:landing|commit|target)`/);
    // r10: judge-46 read a quoted rule of 75 words, and one with no full stop, under a mark refusal.
    const quoted = text
      .split('\n')
      .filter((l) => l.startsWith('> '))
      .map((l) => l.slice(2))
      .join(' ')
      .trim();
    for (const sentence of quoted === '' ? [] : quoted.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      expect(sentence, sentence).toMatch(/^[A-Z]/);
      expect(sentence, sentence).toMatch(/\.$/);
      expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(20);
    }
  }

  // r10: what an agent's mark with nothing behind it is told is the mark's own three sentences; the
  // lane's rules (an unreadable repository, declaring outside git, a base branch is not evidence)
  // belong to the doors that move a status, not appended to this answer.
  it.each(doors)(
    'answers a git-lane mark with no branch and no commit in its own words alone (%s)',
    (door) => {
      const said = noWorkEvidenceDetail(git, 'mark', door);
      expect(said).not.toContain('\n');
      expect(said).not.toMatch(/PATCH|forge_issues|release chain|cannot verify/);
      expect(said).toBe(
        'Nothing was marked, because this mark names no commit and no branch is recorded for this issue. ' +
          `Record the branch in \`sessionContext.branch\`, or name the commit it landed at on the base branch in ${door === 'mcp' ? '`data.commit`' : '`commit`'}. ` +
          "Forge checks that commit against the project's repository.",
      );
    },
  );

  const cases = doors.flatMap(
    (door) =>
      [
        [
          `LANDING_REQUIRED (${door})`,
          door,
          landingMarkRefusal({ lane: outside, landing: null, observed: false, door })?.detail,
        ],
        [
          `LANDING_NOT_THIS_SHAPE (${door})`,
          door,
          landingMarkRefusal({ lane: git, landing: 'x', observed: false, door })?.detail,
        ],
        [
          `NO_WORK_EVIDENCE outside git (${door})`,
          door,
          noWorkEvidenceDetail(outside, 'mark', door),
        ],
        [`NO_WORK_EVIDENCE in git (${door})`, door, noWorkEvidenceDetail(git, 'mark', door)],
        [
          `NO_WORK_EVIDENCE, lane unknown (${door})`,
          door,
          noWorkEvidenceDetail(null, 'mark', door),
        ],
        [`TARGET_REQUIRED (${door})`, door, targetRequiredDetail(door)],
      ] as const,
  );

  it.each(cases)('%s reads in three short sentences naming its own field', (_n, door, text) => {
    expect(text).toBeTruthy();
    refusalReads(text as string, door);
  });

  it('names the landing field each door sends, and what it holds', () => {
    expect(landingMarkRefusal({ lane: outside, landing: null, observed: false })?.detail).toBe(
      'Nothing was marked, because this issue is declared to land outside git and no merged pull request shows where. ' +
        'Send `landing` naming the live URL, CMS entry or storefront resource the work now is.',
    );
    expect(noWorkEvidenceDetail(outside, 'mark', 'mcp')).toBe(
      'Nothing was marked, because this mark names no landing and no branch is recorded for this issue. ' +
        'Send `data.landing` naming the live URL, CMS entry or storefront resource the work now is.',
    );
  });

  it('answers a missing target in one sentence naming the field, at each door', () => {
    expect(targetRequiredDetail('rest')).toBe('Name the branch the work merged into as `target`.');
    expect(targetRequiredDetail('mcp')).toBe(
      'Name where the work merged as `data.target`: base, prod or feature.',
    );
  });
});

// ISS-1421 r9 repair: the host's line rendered as "( git@github.com : Permission denied …)", a code
// span inside brackets with a gap before the colon. It now stands as one code line of its own.
describe("the host's own line under a mark (ISS-1421 r9)", () => {
  const WHY =
    "The git host refused this project's deploy key. Give the key read access to git@github.com:acme/shop.git, which is all Forge needs; devices that push with it need write access.\ngit@github.com: Permission denied (publickey).";

  it('quotes our sentences, then the host line whole as code on a line of its own', () => {
    const said = withReason('The mark stays a claim that names no commit.', WHY);
    expect(said).toBe(
      'The mark stays a claim that names no commit.\n' +
        "> The git host refused this project's deploy key. Give the key read access to git@github.com:acme/shop.git, which is all Forge needs; devices that push with it need write access.\n" +
        '>\n> `git@github.com: Permission denied (publickey).`',
    );
    expect(addressesAsCode(said)).toContain('> `git@github.com: Permission denied (publickey).`');
    expect(addressesAsCode(said)).not.toMatch(/\(`?git@github\.com`? ?:/);
  });
});
