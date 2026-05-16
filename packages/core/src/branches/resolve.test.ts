import { describe, expect, it } from 'vitest';
import {
  type IssueLike,
  type ProjectLike,
  resolveIssueBranches,
} from './resolve.js';

describe('resolveIssueBranches', () => {
  const cases: Array<{
    name: string;
    issue: IssueLike;
    project: ProjectLike;
    expected: { baseBranch: string; targetBranch: string; prodBranch: string };
  }> = [
    {
      name: 'no override, no project defaults → hard default main',
      issue: {},
      project: { baseBranch: null, productionBranch: null },
      expected: { baseBranch: 'main', targetBranch: 'main', prodBranch: 'main' },
    },
    {
      name: 'no override, project defaults present → project wins, target follows base',
      issue: {},
      project: { baseBranch: 'develop', productionBranch: 'release' },
      expected: { baseBranch: 'develop', targetBranch: 'develop', prodBranch: 'release' },
    },
    {
      name: 'full override wins on all three',
      issue: {
        metadata: {
          branchConfig: { baseBranch: 'feat/x', targetBranch: 'feat/x', prodBranch: 'prod' },
        },
      },
      project: { baseBranch: 'develop', productionBranch: 'release' },
      expected: { baseBranch: 'feat/x', targetBranch: 'feat/x', prodBranch: 'prod' },
    },
    {
      name: 'partial override (baseBranch) — target follows new base, prod falls through',
      issue: { metadata: { branchConfig: { baseBranch: 'feat/x' } } },
      project: { baseBranch: 'develop', productionBranch: 'release' },
      expected: { baseBranch: 'feat/x', targetBranch: 'feat/x', prodBranch: 'release' },
    },
    {
      name: 'partial override (prodBranch) — base/target unchanged',
      issue: { metadata: { branchConfig: { prodBranch: 'hotfix' } } },
      project: { baseBranch: 'develop', productionBranch: 'release' },
      expected: { baseBranch: 'develop', targetBranch: 'develop', prodBranch: 'hotfix' },
    },
    {
      name: 'partial override (targetBranch) — prod falls to hard default when project missing',
      issue: { metadata: { branchConfig: { targetBranch: 'integration' } } },
      project: { baseBranch: 'develop', productionBranch: null },
      expected: { baseBranch: 'develop', targetBranch: 'integration', prodBranch: 'main' },
    },
    {
      name: 'empty-string override is treated as absent',
      issue: { metadata: { branchConfig: { baseBranch: '' } } },
      project: { baseBranch: 'develop', productionBranch: 'release' },
      expected: { baseBranch: 'develop', targetBranch: 'develop', prodBranch: 'release' },
    },
    {
      name: 'whitespace-only override is treated as absent',
      issue: { metadata: { branchConfig: { prodBranch: '   ' } } },
      project: { baseBranch: 'develop', productionBranch: 'release' },
      expected: { baseBranch: 'develop', targetBranch: 'develop', prodBranch: 'release' },
    },
    {
      name: 'metadata.branchConfig = null behaves like no override',
      issue: { metadata: { branchConfig: null } },
      project: { baseBranch: 'develop', productionBranch: 'release' },
      expected: { baseBranch: 'develop', targetBranch: 'develop', prodBranch: 'release' },
    },
    {
      name: 'metadata = null behaves like no override',
      issue: { metadata: null },
      project: { baseBranch: 'develop', productionBranch: 'release' },
      expected: { baseBranch: 'develop', targetBranch: 'develop', prodBranch: 'release' },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveIssueBranches(c.issue, c.project)).toEqual(c.expected);
    });
  }

  it('does not mutate its inputs', () => {
    const issue: IssueLike = {
      metadata: { branchConfig: { baseBranch: 'feat/x' } },
    };
    const project: ProjectLike = { baseBranch: 'develop', productionBranch: 'release' };
    const issueSnapshot = structuredClone(issue);
    const projectSnapshot = structuredClone(project);

    resolveIssueBranches(issue, project);

    expect(issue).toEqual(issueSnapshot);
    expect(project).toEqual(projectSnapshot);
  });

  it('returns a fresh object each call', () => {
    const issue: IssueLike = {};
    const project: ProjectLike = { baseBranch: 'develop', productionBranch: 'release' };
    const a = resolveIssueBranches(issue, project);
    const b = resolveIssueBranches(issue, project);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
