import { describe, expect, it } from 'vitest';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { RangeCommit } from '../projects/repository-reader.js';
import { type CarriedReading, judgeCarried, type LandedIssue } from './carried.js';
import type { ReadRange } from './cut-range.js';

const sha = (c: string) => c.repeat(40);
const commit = (c: string, parent: string, message = `land ${c}`): RangeCommit => ({
  sha: sha(c),
  parents: [sha(parent)],
  message,
});

const A = commit('a', '0');
const B = commit('b', 'a');
const C = commit('c', 'b');

function range(commits: RangeCommit[], cut = commits.at(-1)?.sha ?? sha('0')): ReadRange {
  return { live: 'production', start: 'main', cut, commits };
}

const issue = (id: string, landing: string, status = 'needs_info'): LandedIssue => ({
  issueId: id,
  displayId: formatIssueRef(null, Number(id)),
  status,
  landing,
});

function read(original: ReadRange, landed: LandedIssue[], final = original): CarriedReading {
  return { kind: 'read', original, final, landed };
}

describe('judgeCarried (ISS-1386)', () => {
  it('names every off-roster landing in the range as undecided, whatever its status', () => {
    const check = judgeCarried(
      read(range([A, B, C]), [
        issue('1', sha('a'), 'awaiting_release'),
        issue('2', sha('b'), 'needs_info'),
        issue('3', sha('c'), 'closed'),
      ]),
      ['1'],
      [],
    );

    expect(check.kind).toBe('read');
    if (check.kind !== 'read') return;
    expect(check.undecided.map((i) => [i.displayId, i.status])).toEqual([
      ['ISS-2', 'needs_info'],
      ['ISS-3', 'closed'],
    ]);
    expect(check.cut).toBe(sha('c'));
  });

  it('matches a landing stored abbreviated', () => {
    const check = judgeCarried(read(range([A]), [issue('1', 'aaaaaaa')]), [], []);
    expect(check.kind === 'read' && check.undecided.map((i) => i.issueId)).toEqual(['1']);
  });

  it('takes a ship-unverified decision carrying its reason, and refuses one that says nothing', () => {
    const landed = [issue('1', sha('a')), issue('2', sha('b'))];
    const check = judgeCarried(
      read(range([A, B]), landed),
      [],
      [
        { issueId: '1', decision: 'ship-unverified', why: 'criterion 2 needs payroll writes' },
        { issueId: '2', decision: 'ship-unverified', why: '  ' },
      ],
    );

    if (check.kind !== 'read') throw new Error('unread');
    expect(check.carried.find((i) => i.issueId === '1')).toMatchObject({
      decision: 'ship-unverified',
      why: 'criterion 2 needs payroll writes',
    });
    expect(check.undecided).toEqual([]);
    expect(check.refused.map((r) => r.issueId)).toEqual(['2']);
  });

  it('accepts a revert only where the range reverts the landing and nothing reverts the revert', () => {
    const revert = commit('d', 'c', `Revert "land b"\n\nThis reverts commit ${sha('b')}.`);
    const undo = commit('e', 'd', `Revert "Revert"\n\nThis reverts commit ${sha('d')}.`);
    const landed = [issue('2', sha('b'))];
    const decision = [{ issueId: '2', decision: 'revert' as const }];

    const reverted = judgeCarried(read(range([A, B, C, revert]), landed), [], decision);
    const undone = judgeCarried(read(range([A, B, C, revert, undo]), landed), [], decision);
    const none = judgeCarried(read(range([A, B, C]), landed), [], decision);

    expect(reverted.kind === 'read' && reverted.refused).toEqual([]);
    expect(undone.kind === 'read' && undone.refused.map((r) => r.issueId)).toEqual(['2']);
    expect(none.kind === 'read' && none.refused[0]?.why).toMatch(/no commit up to the cut reverts/);
  });

  it('takes a cut-below whose moved cut leaves the issue out, and names it as cut below', () => {
    const landed = [issue('2', sha('c'))];
    const check = judgeCarried(
      read(range([A, B, C]), landed, range([A, B])),
      [],
      [{ issueId: '2', decision: 'cut-below' }],
    );

    if (check.kind !== 'read') throw new Error('unread');
    expect(check.carried).toEqual([]);
    expect(check.cutBelow.map((i) => i.issueId)).toEqual(['2']);
    expect(check.cut).toBe(sha('b'));
  });

  it('names a roster member the moved cut leaves above it', () => {
    const landed = [issue('1', sha('c'), 'awaiting_release'), issue('2', sha('b'))];
    const check = judgeCarried(
      read(range([A, B, C]), landed, range([A])),
      ['1'],
      [{ issueId: '2', decision: 'cut-below' }],
    );

    expect(check.kind === 'read' && check.droppedRoster.map((i) => i.issueId)).toEqual(['1']);
  });

  it('refuses a decision for an issue the range does not carry, and for a roster member', () => {
    const check = judgeCarried(
      read(range([A]), [issue('1', sha('a'))]),
      ['1'],
      [
        { issueId: '1', decision: 'revert' },
        { issueId: '9', decision: 'ship-unverified', why: 'x' },
      ],
    );

    expect(check.kind === 'read' && check.refused.map((r) => r.issueId)).toEqual(['1', '9']);
  });

  it('passes a range that was not read through as it came', () => {
    const unread = { kind: 'unbound' as const, why: 'no binding' };
    expect(judgeCarried(unread, [], [])).toBe(unread);
  });
});
