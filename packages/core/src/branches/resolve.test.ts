import { describe, expect, it } from 'vitest';
import { type IssueLike, type ProjectLike, resolveIssueBranches } from './resolve.js';

describe('resolveIssueBranches', () => {
  const cases: Array<{
    name: string;
    issue: IssueLike;
    project: ProjectLike;
    expected: { baseBranch: string | null; targetBranch: string | null; liveBranch: string | null };
  }> = [
    {
      name: 'no override, no project defaults → null (no hard fallback to main)',
      issue: {},
      project: { baseBranch: null, liveBranch: null },
      expected: { baseBranch: null, targetBranch: null, liveBranch: null },
    },
    {
      name: 'no override, project defaults present → project wins, target follows base',
      issue: {},
      project: { baseBranch: 'develop', liveBranch: 'release' },
      expected: { baseBranch: 'develop', targetBranch: 'develop', liveBranch: 'release' },
    },
    {
      name: 'full override wins on all three',
      issue: {
        metadata: {
          branchConfig: { baseBranch: 'feat/x', targetBranch: 'feat/x', liveBranch: 'prod' },
        },
      },
      project: { baseBranch: 'develop', liveBranch: 'release' },
      expected: { baseBranch: 'feat/x', targetBranch: 'feat/x', liveBranch: 'prod' },
    },
    {
      name: 'partial override (baseBranch) — target follows new base, prod falls through',
      issue: { metadata: { branchConfig: { baseBranch: 'feat/x' } } },
      project: { baseBranch: 'develop', liveBranch: 'release' },
      expected: { baseBranch: 'feat/x', targetBranch: 'feat/x', liveBranch: 'release' },
    },
    {
      name: 'partial override (liveBranch) — base/target unchanged',
      issue: { metadata: { branchConfig: { liveBranch: 'hotfix' } } },
      project: { baseBranch: 'develop', liveBranch: 'release' },
      expected: { baseBranch: 'develop', targetBranch: 'develop', liveBranch: 'hotfix' },
    },
    {
      name: 'partial override (targetBranch) — prod returns null when project column missing',
      issue: { metadata: { branchConfig: { targetBranch: 'integration' } } },
      project: { baseBranch: 'develop', liveBranch: null },
      expected: { baseBranch: 'develop', targetBranch: 'integration', liveBranch: null },
    },
    {
      name: 'empty-string override is treated as absent',
      issue: { metadata: { branchConfig: { baseBranch: '' } } },
      project: { baseBranch: 'develop', liveBranch: 'release' },
      expected: { baseBranch: 'develop', targetBranch: 'develop', liveBranch: 'release' },
    },
    {
      name: 'whitespace-only override is treated as absent',
      issue: { metadata: { branchConfig: { liveBranch: '   ' } } },
      project: { baseBranch: 'develop', liveBranch: 'release' },
      expected: { baseBranch: 'develop', targetBranch: 'develop', liveBranch: 'release' },
    },
    {
      name: 'metadata.branchConfig = null behaves like no override',
      issue: { metadata: { branchConfig: null } },
      project: { baseBranch: 'develop', liveBranch: 'release' },
      expected: { baseBranch: 'develop', targetBranch: 'develop', liveBranch: 'release' },
    },
    {
      name: 'metadata = null behaves like no override',
      issue: { metadata: null },
      project: { baseBranch: 'develop', liveBranch: 'release' },
      expected: { baseBranch: 'develop', targetBranch: 'develop', liveBranch: 'release' },
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
    const project: ProjectLike = { baseBranch: 'develop', liveBranch: 'release' };
    const issueSnapshot = structuredClone(issue);
    const projectSnapshot = structuredClone(project);

    resolveIssueBranches(issue, project);

    expect(issue).toEqual(issueSnapshot);
    expect(project).toEqual(projectSnapshot);
  });

  it('returns a fresh object each call', () => {
    const issue: IssueLike = {};
    const project: ProjectLike = { baseBranch: 'develop', liveBranch: 'release' };
    const a = resolveIssueBranches(issue, project);
    const b = resolveIssueBranches(issue, project);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
