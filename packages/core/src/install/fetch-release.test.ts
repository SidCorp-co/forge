import { describe, expect, it } from 'vitest';

import { cmpVersion, pickLatestRunnerTag, tagToVersion } from './fetch-release.js';

// Minimal Release-shaped fixtures — only the fields pickLatestRunnerTag reads.
function rel(tag: string, opts: { draft?: boolean; prerelease?: boolean } = {}) {
  return { tag_name: tag, draft: opts.draft ?? false, prerelease: opts.prerelease ?? false, assets: [] };
}

describe('tagToVersion', () => {
  it('strips the runner-v prefix', () => {
    expect(tagToVersion('runner-v0.2.11')).toBe('0.2.11');
  });
  it('leaves a bare version untouched', () => {
    expect(tagToVersion('0.2.11')).toBe('0.2.11');
  });
});

describe('cmpVersion', () => {
  it('orders by numeric component', () => {
    expect(cmpVersion('0.2.11', '0.2.9')).toBeGreaterThan(0);
    expect(cmpVersion('0.2.9', '0.2.10')).toBeLessThan(0);
    expect(cmpVersion('0.2.11', '0.2.11')).toBe(0);
  });
});

describe('pickLatestRunnerTag', () => {
  it('returns the highest semver among runner-v releases', () => {
    const picked = pickLatestRunnerTag([
      rel('runner-v0.2.9'),
      rel('runner-v0.2.11'),
      rel('runner-v0.2.10'),
    ]);
    expect(picked?.tag_name).toBe('runner-v0.2.11');
  });

  it('treats 0.2.11 as newer than 0.2.10 (not lexicographic)', () => {
    const picked = pickLatestRunnerTag([rel('runner-v0.2.10'), rel('runner-v0.2.11')]);
    expect(picked?.tag_name).toBe('runner-v0.2.11');
  });

  it('ignores non-runner-v tags', () => {
    const picked = pickLatestRunnerTag([rel('v0.9.0'), rel('app-v1.0.0'), rel('runner-v0.1.0')]);
    expect(picked?.tag_name).toBe('runner-v0.1.0');
  });

  it('ignores drafts and prereleases', () => {
    const picked = pickLatestRunnerTag([
      rel('runner-v0.3.0', { draft: true }),
      rel('runner-v0.2.99', { prerelease: true }),
      rel('runner-v0.2.11'),
    ]);
    expect(picked?.tag_name).toBe('runner-v0.2.11');
  });

  it('returns null when no runner-v release qualifies', () => {
    expect(pickLatestRunnerTag([rel('v1.0.0'), rel('runner-v0.4.0', { draft: true })])).toBeNull();
  });
});
