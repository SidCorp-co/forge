import { describe, expect, it } from 'vitest';
import { buildJobPromptString } from './prompt-string.js';

describe('buildJobPromptString', () => {
  it('returns /<skillName> <issueId> when a skill name is provided', () => {
    expect(
      buildJobPromptString({ skillName: 'forge-plan', jobType: 'plan', issueId: 'iss-1' }),
    ).toBe('/forge-plan iss-1');
    expect(
      buildJobPromptString({ skillName: 'custom-skill', jobType: 'code', issueId: 'iss-2' }),
    ).toBe('/custom-skill iss-2');
  });

  it('falls back to /forge-<jobType> when skillName is null/missing/empty', () => {
    expect(buildJobPromptString({ skillName: null, jobType: 'plan', issueId: 'iss-1' })).toBe(
      '/forge-plan iss-1',
    );
    expect(buildJobPromptString({ jobType: 'review', issueId: 'iss-2' })).toBe(
      '/forge-review iss-2',
    );
    expect(buildJobPromptString({ skillName: '', jobType: 'fix', issueId: 'iss-3' })).toBe(
      '/forge-fix iss-3',
    );
  });
});
