/**
 * ISS-1391 — what a release tag pattern matches, away from any repository. The pattern is the
 * project's own words for "this tag ships us", so the two ways it can be wrong are matching a tag
 * it was not meant to (a regex metacharacter read as one, a prefix read as the whole name) and
 * ranking the newest tag as an older one, which a refusal would then name.
 */

import { describe, expect, it } from 'vitest';
import { matchingTagsNewestFirst, tagMatchesPattern } from './release-tag.js';

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
