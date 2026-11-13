import { describe, expect, it } from 'vitest';
import { releaseBlockerSentence } from './blocker-sentences.js';
import { releaseBlockerReaderSentence } from './reader-sentences.js';

// ISS-1421 r41 (judge-167): on a project naming no repository, the Batch release dialog and Shape &
// release told the reader to use Mark merged without saying Commit may stay empty (criterion 393).
describe('an issue not marked merged on a project that names no repository', () => {
  it("says Commit may stay empty, as Mark merged's own panel does", () => {
    const said = releaseBlockerReaderSentence('RELEASE_WORK_UNMERGED', {
      issueIds: ['u-1'],
      displayIds: ['ISS-6'],
      shape: 'git',
      noRepository: true,
    });
    expect(said).toBe(
      "ISS-6 is not marked merged, so nothing says its work is on the branch this release deploys, and a release closes what it carries. Use Mark merged in the issue's properties. In the panel it opens, fill in Where it landed; with no repository named, Commit may stay empty.",
    );
  });

  it('still asks for the commit under Commit where the project names one', () => {
    const said = releaseBlockerReaderSentence('RELEASE_WORK_UNMERGED', {
      issueIds: ['u-1'],
      displayIds: ['ISS-6'],
      shape: 'git',
    });
    expect(said).toContain('name the commit that landed under Commit');
    expect(said).not.toContain('may stay empty');
  });

  // ISS-1421 r43 (judge-171 on 407): a repository named that Forge cannot read refuses a commit.
  it('says to leave Commit empty for a claim where Forge cannot read the named repository', () => {
    const details = {
      issueIds: ['u-1'],
      displayIds: ['ISS-6'],
      shape: 'git',
      repositoryUnreadable: true,
    };
    const said = releaseBlockerReaderSentence('RELEASE_WORK_UNMERGED', details);
    expect(said).toContain(
      'fill in Where it landed. Leave Commit empty to record a claim naming no commit.',
    );
    expect(said).not.toContain('name the commit that landed');
    expect(releaseBlockerSentence('RELEASE_WORK_UNMERGED', details)).toContain(
      "Forge cannot read this project's repository, so a mark naming a commit is refused; mark it naming none.",
    );
  });

  it('tells an API caller a mark may name no commit there', () => {
    const said = releaseBlockerSentence('RELEASE_WORK_UNMERGED', {
      issueIds: ['u-1'],
      displayIds: ['ISS-6'],
      shape: 'git',
      noRepository: true,
    });
    expect(said).toContain('This project names no repository, so the mark may name no commit.');
  });
});

// ISS-1421 r41 (judge-167): Shape & release and the Batch release dialog read "1 issue named here
// (ISS-6)" to a reader who named nothing.
describe('the issues a reader sentence is about', () => {
  const refused = [
    {
      issueId: 'u-4',
      displayId: 'ISS-4',
      shortfalls: [
        { code: 'OPEN_QUESTIONS', reason: 'holds 1 open question', clears: 'Answer it.' },
      ],
    },
  ];
  it.each([
    [
      'RELEASE_RECORD_MISSING',
      { issueIds: ['u-5', 'u-4'], displayIds: ['ISS-5', 'ISS-4'] },
      /^ISS-5 and ISS-4 have no release note/,
    ],
    [
      'RELEASE_WORK_UNMERGED',
      { issueIds: ['u-6'], displayIds: ['ISS-6'], shape: 'git' },
      /^ISS-6 is not marked merged/,
    ],
    [
      'RELEASE_WORK_UNMERGED',
      { issueIds: ['u-6'], displayIds: ['ISS-6'], shape: 'outside_git' },
      /^ISS-6 has no mark/,
    ],
    [
      'RELEASE_ISSUES_UNCLOSABLE',
      { issueIds: ['u-4'], displayIds: ['ISS-4'], refused },
      /^ISS-4 would be refused its close/,
    ],
    ['RELEASE_RECORD_MISSING', { issueIds: ['u-5', 'u-4'] }, /^2 issues have no release note/],
  ] as const)('names them by id, never "named here" (%s)', (code, details, opening) => {
    const said = releaseBlockerReaderSentence(code, details as Record<string, unknown>);
    expect(said).toMatch(opening);
    expect(said).not.toContain('named here');
  });
});
