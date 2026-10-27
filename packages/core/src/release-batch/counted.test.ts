import { describe, expect, it } from 'vitest';
import { ReleaseRosterUnusableError } from './blocker-errors.js';
import { releaseBlockerSentence } from './blocker-sentences.js';
import { agree, counted } from './counted.js';
import {
  ReleaseIssuesUnclosableError,
  ReleaseRecordMissingError,
  ReleaseWorkUnmergedError,
} from './errors.js';

describe('a count in the number it counts', () => {
  it('says one in the singular and every other count in the plural', () => {
    expect([0, 1, 2].map((n) => counted(n, 'issue'))).toEqual(['0 issues', '1 issue', '2 issues']);
    expect(counted(1, 'entry', 'entries')).toBe('1 entry');
    expect(counted(3, 'entry', 'entries')).toBe('3 entries');
  });

  it('picks the word that agrees with the count', () => {
    expect([agree(1, 'has', 'have'), agree(2, 'has', 'have')]).toEqual(['has', 'have']);
  });
});

describe('a release refusal counts its issues in their number', () => {
  it.each([
    [new ReleaseRecordMissingError(['a']), 'RELEASE_RECORD_MISSING: 1 issue has no release note'],
    [
      new ReleaseRecordMissingError(['a', 'b']),
      'RELEASE_RECORD_MISSING: 2 issues have no release note',
    ],
    [
      new ReleaseWorkUnmergedError(['a']),
      'RELEASE_WORK_UNMERGED: 1 issue is not marked merged',
    ],
    [
      new ReleaseWorkUnmergedError(['a', 'b']),
      'RELEASE_WORK_UNMERGED: 2 issues are not marked merged',
    ],
    [
      new ReleaseIssuesUnclosableError(['a']),
      'RELEASE_ISSUES_UNCLOSABLE: 1 issue would be refused its close',
    ],
    [
      new ReleaseIssuesUnclosableError(['a', 'b']),
      'RELEASE_ISSUES_UNCLOSABLE: 2 issues would be refused their close',
    ],
    [
      new ReleaseRosterUnusableError('RELEASE_ROSTER_OVERSIZE', 1),
      'RELEASE_ROSTER_OVERSIZE: 1 issue at the release gate',
    ],
    [
      new ReleaseRosterUnusableError('RELEASE_ROSTER_OVERSIZE', 51),
      'RELEASE_ROSTER_OVERSIZE: 51 issues at the release gate',
    ],
  ])('%s', (err, said) => {
    expect(err.message).toBe(said);
  });
});

// The coordinator read "2 issue(s) named here have no release note" on Shape & release (ISS-1229 r7):
// a sentence that counts says the count in its own number, at one and at more than one.
describe('a release sentence that counts says it in the number it counts', () => {
  const one = { issueIds: ['a'], displayIds: ['ISS-1'] };
  const two = { issueIds: ['a', 'b'], displayIds: ['ISS-1', 'ISS-2'] };
  const conflict = (keys: string[]) => ({
    issueIds: keys,
    projectId: 'p',
    gateStatus: 'awaiting_release',
    conflicts: keys.map((key) => ({ id: key, key, standing: 'absent' })),
  });

  it.each([
    [
      'RELEASE_RECORD_MISSING',
      one,
      '1 issue named here (`ISS-1`) has no release note, and closing it would',
    ],
    [
      'RELEASE_RECORD_MISSING',
      two,
      '2 issues named here (`ISS-1`, `ISS-2`) have no release note, and closing them would',
    ],
    [
      'RELEASE_WORK_UNMERGED',
      one,
      '1 issue named here (`ISS-1`) is not marked merged, so nothing says its work',
    ],
    [
      'RELEASE_WORK_UNMERGED',
      two,
      '2 issues named here (`ISS-1`, `ISS-2`) are not marked merged, so nothing says their work',
    ],
    [
      'RELEASE_WORK_UNMERGED',
      { ...one, shape: 'outside_git' },
      '1 issue named here (`ISS-1`) has no mark saying where its work landed',
    ],
    [
      'RELEASE_WORK_UNMERGED',
      { ...two, shape: 'outside_git' },
      '2 issues named here (`ISS-1`, `ISS-2`) have no mark saying where their work landed',
    ],
    [
      'RELEASE_CUT_DROPS_ROSTER',
      { ...one, cut: 'abc' },
      'leaves the landing of roster issue `ISS-1` above the cut',
    ],
    [
      'RELEASE_CUT_DROPS_ROSTER',
      { ...two, cut: 'abc' },
      'leaves the landing of roster issues `ISS-1`, `ISS-2` above the cut',
    ],
    [
      'RELEASE_CARRIES_UNDECIDED',
      {
        carried: [{ displayId: 'ISS-9', status: 'testing' }],
        start: 'dev',
        cut: 'abc',
        live: 'main',
      },
      'carries the landing of 1 issue this batch does not name',
    ],
    [
      'RELEASE_CARRIES_UNDECIDED',
      {
        carried: [
          { displayId: 'ISS-8', status: 'testing' },
          { displayId: 'ISS-9', status: 'testing' },
        ],
        start: 'dev',
        cut: 'abc',
        live: 'main',
      },
      'carries the landing of 2 issues this batch does not name',
    ],
    [
      'RELEASE_CARRIED_DECISION_REFUSED',
      { refused: [{ displayId: 'ISS-9', decision: 'revert', why: 'not reverted' }] },
      '1 decision sent with this batch does not hold',
    ],
    [
      'RELEASE_CARRIED_DECISION_REFUSED',
      {
        refused: [
          { displayId: 'ISS-8', decision: 'revert', why: 'a' },
          { displayId: 'ISS-9', decision: 'revert', why: 'b' },
        ],
      },
      '2 decisions sent with this batch do not hold',
    ],
  ] as const)('%s with %j', (code, details, said) => {
    expect(releaseBlockerSentence(code, details as Record<string, unknown>)).toContain(said);
  });

  it('writes no count with "(s)" for any code, at one issue or two', () => {
    for (const details of [one, two, conflict(['ISS-1']), conflict(['ISS-1', 'ISS-2'])]) {
      for (const code of [
        'CLAIM_CONFLICT',
        'RELEASE_RECORD_MISSING',
        'RELEASE_WORK_UNMERGED',
        'RELEASE_ISSUES_UNCLOSABLE',
        'RELEASE_CUT_DROPS_ROSTER',
      ] as const) {
        expect(releaseBlockerSentence(code, details), code).not.toMatch(/\(s\)|\{n\}/);
      }
    }
  });

  it('says a refusal with no issue named without a count it cannot know', () => {
    for (const code of [
      'CLAIM_CONFLICT',
      'RELEASE_RECORD_MISSING',
      'RELEASE_WORK_UNMERGED',
      'RELEASE_ISSUES_UNCLOSABLE',
    ] as const) {
      expect(releaseBlockerSentence(code), code).not.toMatch(/\(s\)|\{n\}/);
    }
  });
});
