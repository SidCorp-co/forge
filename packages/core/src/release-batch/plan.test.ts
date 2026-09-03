import { describe, expect, it } from 'vitest';
import { ReleaseBranchesUndeclaredError, releaseBranches } from './plan.js';

describe('releaseBranches', () => {
  // cm:guard this is the row that cut three aborted batches on 2026-09-03: the old loader answered `main → main` for it
  it('promotes staging → master for a project whose columns say so', () => {
    expect(releaseBranches({ baseBranch: 'staging', productionBranch: 'master' })).toEqual({
      baseBranch: 'staging',
      productionBranch: 'master',
      productionMergePlanned: true,
    });
  });

  it('a project without a production branch releases from its base and plans no merge', () => {
    expect(releaseBranches({ baseBranch: 'main', productionBranch: null })).toEqual({
      baseBranch: 'main',
      productionBranch: 'main',
      productionMergePlanned: false,
    });
    expect(
      releaseBranches({ baseBranch: 'dev', productionBranch: '  ' }).productionMergePlanned,
    ).toBe(false);
  });

  it('an undeclared base branch is an error, never main', () => {
    expect(() => releaseBranches({ baseBranch: null, productionBranch: 'master' })).toThrow(
      ReleaseBranchesUndeclaredError,
    );
    expect(() => releaseBranches({ baseBranch: '', productionBranch: null })).toThrow(
      ReleaseBranchesUndeclaredError,
    );
  });
});
