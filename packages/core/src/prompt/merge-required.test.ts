/**
 * ISS-232 — merge-required prompt injection tests.
 *
 * Pure-function tests: `buildMergeRequiredBlock` derives the text block
 * from `(stageStatus, mergeStates, issueId)` and returns null for stages
 * that don't match. `buildJobPromptString` splices the block in
 * immediately after the `/<skill> <issueId>` line.
 */

import { describe, expect, it } from 'vitest';
import { buildJobPromptString } from './user.js';
import { buildMergeRequiredBlock } from './merge-required.js';

const TRUNK_MERGE = { baseBranch: 'released', productionBranch: 'released' } as const;
const SPLIT_MERGE = { baseBranch: 'staging', productionBranch: 'released' } as const;

describe('buildMergeRequiredBlock', () => {
  it('returns null when stage does not match either branch', () => {
    expect(
      buildMergeRequiredBlock({
        stageStatus: 'open',
        mergeStates: TRUNK_MERGE,
        issueId: 'iss-1',
      }),
    ).toBeNull();
  });

  it('returns null when stageStatus is null/undefined (PM, custom, etc.)', () => {
    expect(
      buildMergeRequiredBlock({
        stageStatus: null,
        mergeStates: TRUNK_MERGE,
        issueId: 'iss-1',
      }),
    ).toBeNull();
    expect(
      buildMergeRequiredBlock({
        stageStatus: undefined,
        mergeStates: TRUNK_MERGE,
        issueId: 'iss-1',
      }),
    ).toBeNull();
  });

  it('emits a single block for trunk-based projects (base === production)', () => {
    const block = buildMergeRequiredBlock({
      stageStatus: 'released',
      mergeStates: TRUNK_MERGE,
      issueId: 'iss-trunk',
    });
    expect(block).not.toBeNull();
    // One block (matches baseBranch only; productionBranch collapses).
    const headers = block!.match(/## Merge required/g) ?? [];
    expect(headers).toHaveLength(1);
    expect(block).toContain('iss-trunk');
    expect(block).toContain('git checkout released');
    expect(block).toContain('git push origin released');
  });

  it('emits two blocks when stage matches both base and production with distinct refs', () => {
    // Hypothetical multi-branch project where one stage triggers both
    // merges. Production stage matches productionBranch only, so to exercise
    // both-branch emission we use a stage equal to baseBranch and also
    // assert the productionBranch case below.
    const baseBlock = buildMergeRequiredBlock({
      stageStatus: 'staging',
      mergeStates: SPLIT_MERGE,
      issueId: 'iss-split',
    });
    expect(baseBlock).toContain('git checkout staging');
    expect(baseBlock).not.toContain('git checkout released');

    const prodBlock = buildMergeRequiredBlock({
      stageStatus: 'released',
      mergeStates: SPLIT_MERGE,
      issueId: 'iss-split',
    });
    expect(prodBlock).toContain('git checkout released');
    expect(prodBlock).not.toContain('git checkout staging');
  });

  it('does not duplicate the block when trunk-based stage matches both fields', () => {
    // base === production === 'released'; stageStatus === 'released' matches
    // both, but the helper collapses them into one block.
    const block = buildMergeRequiredBlock({
      stageStatus: 'released',
      mergeStates: TRUNK_MERGE,
      issueId: 'iss-1',
    });
    const headers = block!.match(/## Merge required/g) ?? [];
    expect(headers).toHaveLength(1);
  });
});

describe('buildJobPromptString — mergeRequiredText injection', () => {
  it('splices the block immediately after the /<skill> <id> line', () => {
    const merge = buildMergeRequiredBlock({
      stageStatus: 'released',
      mergeStates: TRUNK_MERGE,
      issueId: 'iss-release',
    });
    const out = buildJobPromptString({
      jobType: 'release',
      issueId: 'iss-release',
      mergeRequiredText: merge,
    });
    const lines = out.split('\n');
    // First line is the skill invocation; second is blank; merge header follows.
    expect(lines[0]).toBe('/forge-release iss-release');
    expect(lines[1]).toBe('');
    expect(lines[2]).toMatch(/^## Merge required/);
  });

  it('omits injection entirely when mergeRequiredText is null/empty', () => {
    const out = buildJobPromptString({
      jobType: 'release',
      issueId: 'iss-1',
      mergeRequiredText: null,
    });
    expect(out).not.toContain('Merge required');

    const outEmpty = buildJobPromptString({
      jobType: 'release',
      issueId: 'iss-1',
      mergeRequiredText: '   \n  ',
    });
    expect(outEmpty).not.toContain('Merge required');
  });

  it('preserves Pipeline Rules block ordering (merge first, then rules)', () => {
    const merge = buildMergeRequiredBlock({
      stageStatus: 'released',
      mergeStates: TRUNK_MERGE,
      issueId: 'iss-1',
    });
    const out = buildJobPromptString({
      jobType: 'release',
      issueId: 'iss-1',
      mergeRequiredText: merge,
      turnLevelSystemPrompt: 'session-resume rules here',
    });
    const mergeIdx = out.indexOf('## Merge required');
    const rulesIdx = out.indexOf('## Pipeline Rules');
    expect(mergeIdx).toBeGreaterThan(0);
    expect(rulesIdx).toBeGreaterThan(mergeIdx);
  });
});
