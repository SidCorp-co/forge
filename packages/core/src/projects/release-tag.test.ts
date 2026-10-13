/**
 * ISS-1391 — what a release tag pattern matches, away from any repository. The pattern is the
 * project's own words for "this tag ships us", so the two ways it can be wrong are matching a tag
 * it was not meant to (a regex metacharacter read as one, a prefix read as the whole name) and
 * ranking the newest tag as an older one, which a refusal would then name.
 */

import { describe, expect, it } from 'vitest';
import { matchingTagsNewestFirst, tagMatchesPattern } from './release-tag.js';
import { compareTags } from './release-tag-order.js';

describe('tagMatchesPattern', () => {
  it('matches the whole name, so a prefix is not a match', () => {
    expect(tagMatchesPattern('v1', 'v1')).toBe(true);
    expect(tagMatchesPattern('v1', 'v10')).toBe(false);
    expect(tagMatchesPattern('v1', 'rev1')).toBe(false);
  });

  it('lets `*` match any run of characters, an empty one and one holding `/` or `.` included', () => {
    expect(tagMatchesPattern('v*', 'v')).toBe(true);
    expect(tagMatchesPattern('v*', 'v1.18.0')).toBe(true);
    expect(tagMatchesPattern('v*.*.*', 'v1.18.0')).toBe(true);
    expect(tagMatchesPattern('v*.*.*', 'v1.18')).toBe(false);
    expect(tagMatchesPattern('release/*', 'release/2026/10')).toBe(true);
    expect(tagMatchesPattern('*', 'anything')).toBe(true);
  });

  it('reads every other character as itself, a dot included', () => {
    expect(tagMatchesPattern('v1.2', 'v1.2')).toBe(true);
    expect(tagMatchesPattern('v1.2', 'v1x2')).toBe(false);
    expect(tagMatchesPattern('a-b_c', 'a-b_c')).toBe(true);
  });

  it('refuses a tag the pattern does not name, however alike', () => {
    expect(tagMatchesPattern('v*', 'nightly-1')).toBe(false);
    expect(tagMatchesPattern('v*', 'runner-v0.3.1')).toBe(false);
  });
});

describe('tagMatchesPattern against a pattern built to make a backtracking matcher explode', () => {
  it('answers a non-match promptly for many wildcards and a name that nearly fits', () => {
    const started = performance.now();
    expect(tagMatchesPattern(`${'*a'.repeat(40)}b`, 'a'.repeat(80))).toBe(false);
    expect(tagMatchesPattern(`${'*'.repeat(50)}z`, 'a'.repeat(200))).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('still finds a match that needs a wildcard to give characters back', () => {
    expect(tagMatchesPattern('a*b*c', 'aXbYbZc')).toBe(true);
    expect(tagMatchesPattern('*a*a*b', 'aaaab')).toBe(true);
    expect(tagMatchesPattern('v*.*.*', 'v1.2.3.4')).toBe(true);
    expect(tagMatchesPattern('a*b', 'ab')).toBe(true);
    expect(tagMatchesPattern('a*b', 'a')).toBe(false);
    expect(tagMatchesPattern('', '')).toBe(true);
    expect(tagMatchesPattern('', 'a')).toBe(false);
  });
});

describe('matchingTagsNewestFirst', () => {
  it('orders by version, not by text, so v1.18.0 is newer than v1.9.0 and v1.2.0', () => {
    expect(matchingTagsNewestFirst('v*', ['v1.2.0', 'v1.18.0', 'v1.9.0'])).toEqual([
      'v1.18.0',
      'v1.9.0',
      'v1.2.0',
    ]);
  });

  it('ranks a release above the prereleases that led up to it', () => {
    expect(
      matchingTagsNewestFirst('v0.1.0*', ['v0.1.0-rc.1', 'v0.1.0', 'v0.1.0-rc.10', 'v0.1.0-rc.9']),
    ).toEqual(['v0.1.0', 'v0.1.0-rc.10', 'v0.1.0-rc.9', 'v0.1.0-rc.1']);
  });

  it('ranks a prerelease of a later version above an earlier release', () => {
    expect(matchingTagsNewestFirst('v*', ['v1.9.0', 'v2.0.0-rc.1', 'v1.10.0'])).toEqual([
      'v2.0.0-rc.1',
      'v1.10.0',
      'v1.9.0',
    ]);
  });

  it('reads a prerelease off a two-part version too', () => {
    expect(matchingTagsNewestFirst('v*', ['v1.0-rc1', 'v1.0', 'v0.9'])).toEqual([
      'v1.0',
      'v1.0-rc1',
      'v0.9',
    ]);
  });

  it('ranks prerelease identifiers as semver does: numeric below alphanumeric, a shorter list below a longer one', () => {
    expect(
      matchingTagsNewestFirst('v*', [
        'v1.0.0-alpha',
        'v1.0.0-alpha.1',
        'v1.0.0-alpha.beta',
        'v1.0.0-beta',
        'v1.0.0-beta.2',
        'v1.0.0-beta.11',
        'v1.0.0-rc.1',
        'v1.0.0',
      ]),
    ).toEqual([
      'v1.0.0',
      'v1.0.0-rc.1',
      'v1.0.0-beta.11',
      'v1.0.0-beta.2',
      'v1.0.0-beta',
      'v1.0.0-alpha.beta',
      'v1.0.0-alpha.1',
      'v1.0.0-alpha',
    ]);
  });

  it('gives a release and the same release with build metadata one precedence', () => {
    expect(compareTags('v1.0.0+build.2', 'v1.0.0')).toBe(0);
    expect(compareTags('v1.0.0+build.2', 'v1.0.0+build.10')).toBe(0);
    expect(compareTags('v1.0.0-rc.1+build.9', 'v1.0.0')).toBeLessThan(0);
    expect(compareTags('v1.0.1+build.1', 'v1.0.0+build.9')).toBeGreaterThan(0);
  });

  it('orders a prefixed family by its own versions and keeps every tag the pattern names', () => {
    const tags = ['runner-v1.0.0-rc.1', 'runner-v1.0.0', 'runner-v0.9.0'];
    expect(matchingTagsNewestFirst('runner-v*', tags)).toEqual([
      'runner-v1.0.0',
      'runner-v1.0.0-rc.1',
      'runner-v0.9.0',
    ]);
  });

  it('keeps a tag that is no version at all, ordered by text after the versions it follows', () => {
    const named = matchingTagsNewestFirst('*', [
      'edge',
      'v1.0.0',
      'nightly-2026-10-9',
      'nightly-2026-10-10',
    ]);
    expect(named).toHaveLength(4);
    expect(named.indexOf('nightly-2026-10-10')).toBeLessThan(named.indexOf('nightly-2026-10-9'));
  });

  it('is one total order whatever the input order', () => {
    const tags = ['v1.0.0', 'v1.0.0-rc.2', 'v1.0.0-rc.10', 'v1.0.1-beta', 'v0.9.9', 'v1.0.0-alpha'];
    const forward = matchingTagsNewestFirst('v*', tags);
    expect(matchingTagsNewestFirst('v*', [...tags].reverse())).toEqual(forward);
  });

  it('keeps only the tags the pattern names', () => {
    expect(matchingTagsNewestFirst('v*', ['nightly-3', 'v1.0.0', 'runner-v9.9.9'])).toEqual([
      'v1.0.0',
    ]);
  });

  it('answers an empty list where no tag matches', () => {
    expect(matchingTagsNewestFirst('v*', [])).toEqual([]);
    expect(matchingTagsNewestFirst('v*', ['x'])).toEqual([]);
  });
});
