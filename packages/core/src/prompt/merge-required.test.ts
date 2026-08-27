import { describe, expect, it } from 'vitest';
import { buildMergeRequiredBlock } from './merge-required.js';
import { buildJobPromptString } from './user.js';

const TRUNK_MERGE = { baseBranch: 'released', productionBranch: 'released' } as const;
const SPLIT_MERGE = { baseBranch: 'tested', productionBranch: 'released' } as const;

function build(args: Partial<Parameters<typeof buildMergeRequiredBlock>[0]> = {}) {
  return buildMergeRequiredBlock({
    stageStatus: 'released',
    mergeStates: TRUNK_MERGE,
    branches: { baseBranch: 'main', targetBranch: 'main', prodBranch: 'main' },
    stageOwnsMergeProtocol: false,
    issueId: 'iss-1',
    ...args,
  });
}

describe('buildMergeRequiredBlock', () => {
  it('returns null when the stage does not match either merge state', () => {
    expect(build({ stageStatus: 'open' })).toBeNull();
  });

  it('returns one block when a trunk stage matches both merge states', () => {
    const block = build({ issueId: 'iss-trunk' });

    expect(block).not.toBeNull();
    expect(block).toContain('iss-trunk');
    expect(block?.match(/## Merge required/g)).toHaveLength(1);
  });

  it('emits the resolved target ref rather than the lifecycle state', () => {
    const block = build({
      stageStatus: 'tested',
      mergeStates: SPLIT_MERGE,
      branches: { baseBranch: 'integration', targetBranch: 'main', prodBranch: 'production' },
    });

    expect(block).toContain('state `tested`');
    expect(block).toContain('git checkout main');
    expect(block).toContain('git push origin main');
    expect(block).not.toContain('git checkout tested');
    expect(block).not.toContain('git push origin tested');
  });

  it('uses the production ref for a production merge point', () => {
    const block = build({
      mergeStates: SPLIT_MERGE,
      branches: { baseBranch: 'integration', targetBranch: 'integration', prodBranch: 'main' },
    });

    expect(block).toContain('git checkout main');
    expect(block).not.toContain('git checkout released');
  });

  it('keeps both merge points when one lifecycle state has distinct refs', () => {
    const block = build({
      branches: { baseBranch: 'main', targetBranch: 'main', prodBranch: 'production' },
    });

    expect(block?.match(/## Merge required/g)).toHaveLength(2);
    expect(block).toContain('git checkout main');
    expect(block).toContain('git checkout production');
  });

  it('does not emit a git command when the target is unset', () => {
    const block = build({
      stageStatus: 'tested',
      mergeStates: SPLIT_MERGE,
      branches: { baseBranch: null, targetBranch: null, prodBranch: 'main' },
    });

    expect(block).toContain('No resolved git ref is configured');
    expect(block).not.toContain('git checkout');
    expect(block).not.toContain('git push');
  });

  it('keeps the merged_at requirement but defers merge procedure to project skills', () => {
    const block = build({ stageOwnsMergeProtocol: true });

    expect(block).toContain('registered project skill owns the git merge procedure');
    expect(block).toContain('forge_issues.mark_merged');
    expect(block).not.toContain('`git checkout');
    expect(block).not.toContain('`git merge');
    expect(block).not.toContain('`git push');
  });
});

describe('buildJobPromptString — mergeRequiredText injection', () => {
  it('splices the block immediately after the skill invocation', () => {
    const out = buildJobPromptString({
      jobType: 'release',
      issueId: 'iss-release',
      mergeRequiredText: build({ issueId: 'iss-release' }),
    });
    const lines = out.split('\n');

    expect(lines[0]).toBe('/forge-release iss-release');
    expect(lines[1]).toBe('');
    expect(lines[2]).toMatch(/^## Merge required/);
  });

  it('omits injection entirely when mergeRequiredText is null or empty', () => {
    expect(
      buildJobPromptString({ jobType: 'release', issueId: 'iss-1', mergeRequiredText: null }),
    ).not.toContain('Merge required');
    expect(
      buildJobPromptString({
        jobType: 'release',
        issueId: 'iss-1',
        mergeRequiredText: '   \n  ',
      }),
    ).not.toContain('Merge required');
  });
});
