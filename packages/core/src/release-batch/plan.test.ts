import { describe, expect, it } from 'vitest';
import { releaseBranches } from './plan.js';

describe('releaseBranches', () => {
  it('promotes staging → master for a chain that names two branches', () => {
    expect(
      releaseBranches({
        baseBranch: 'staging',
        releaseChain: [{ branch: 'staging' }, { branch: 'master', from: 'merge-branch' }],
      }),
    ).toEqual({
      baseBranch: 'staging',
      liveBranch: 'master',
      promotePlanned: true,
    });
  });

  it('plans no promotion for an empty chain, whatever branch work is cut from', () => {
    expect(releaseBranches({ baseBranch: 'release/stg', releaseChain: [] })).toEqual({
      baseBranch: 'release/stg',
      liveBranch: 'release/stg',
      promotePlanned: false,
    });
  });

  it('plans no promotion for a chain of one, which deploys the branch it names', () => {
    expect(releaseBranches({ baseBranch: 'main', releaseChain: [{ branch: 'main' }] })).toEqual({
      baseBranch: 'main',
      liveBranch: 'main',
      promotePlanned: false,
    });
  });

  // ISS-1311 — the enum could say `promote` with no live branch, and an arm here answered for that
  // row. A chain cannot hold it: a second entry IS the live branch. What a chain CAN hold and the
  // enum could not is a third branch, so that is what this case covers instead.
  it('crosses into the LAST branch of a chain longer than two', () => {
    expect(
      releaseBranches({
        baseBranch: 'dev',
        releaseChain: [
          { branch: 'dev' },
          { branch: 'stg', from: 'merge-branch' },
          { branch: 'main', from: 'cherry-pick' },
        ],
      }),
    ).toEqual({
      baseBranch: 'dev',
      liveBranch: 'main',
      promotePlanned: true,
    });
  });

  // ISS-1276 — it threw `RELEASE_BRANCHES_UNDECLARED` here, which refused the release on behalf of
  // a merge step Forge no longer writes. `null` is the reading, and it is never `main`: guessing
  // the branch is what the blocker was standing in the way of.
  it('answers null for an undeclared base branch rather than throwing or guessing main', () => {
    expect(
      releaseBranches({
        baseBranch: null,
        releaseChain: [{ branch: 'staging' }, { branch: 'master', from: 'merge-branch' }],
      }),
    ).toEqual({
      baseBranch: null,
      liveBranch: 'master',
      promotePlanned: true,
    });
    expect(releaseBranches({ baseBranch: '', releaseChain: [] })).toEqual({
      baseBranch: null,
      liveBranch: null,
      promotePlanned: false,
    });
  });

  it('answers null on both branches for a project that declares neither', () => {
    expect(releaseBranches({ baseBranch: null, releaseChain: [] })).toEqual({
      baseBranch: null,
      liveBranch: null,
      promotePlanned: false,
    });
  });
});
