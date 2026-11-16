// ISS-1252: a source is flagged for keep, replace or remove when its repository is archived, when a
// followed repository neither released nor was pushed for 180 days, and when nobody cited it for 90.

import { describe, expect, it } from 'vitest';
import { flagsOf } from './signals.js';

const now = new Date('2026-11-16T00:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const source = {
  addedAt: daysAgo(200),
  followReleases: true,
  repoArchived: false,
  repoPushedAt: daysAgo(3),
  lastReleaseAt: daysAgo(10),
};
const kinds = (s: typeof source, lastAt: Date | null) =>
  flagsOf(s, { lastAt }, now).map((f) => f.kind);

describe('flagsOf', () => {
  it('flags nothing on a source cited within 90 days whose repository is live', () => {
    expect(kinds(source, daysAgo(89))).toEqual([]);
  });

  it('flags a source uncited for 90 days, and one never cited 90 days after it was added', () => {
    expect(kinds(source, daysAgo(91))).toEqual(['uncited']);
    expect(kinds(source, null)).toEqual(['uncited']);
    expect(kinds({ ...source, addedAt: daysAgo(30) }, null)).toEqual([]);
  });

  it('flags an archived repository and one with no release or push for 180 days', () => {
    expect(kinds({ ...source, repoArchived: true }, daysAgo(1))).toEqual(['archived']);
    expect(
      kinds({ ...source, repoPushedAt: daysAgo(181), lastReleaseAt: daysAgo(400) }, daysAgo(1)),
    ).toEqual(['unmaintained']);
  });

  it('reads no unmaintained flag on a source whose releases are not followed', () => {
    expect(
      kinds(
        { ...source, followReleases: false, repoPushedAt: daysAgo(400), lastReleaseAt: null },
        daysAgo(1),
      ),
    ).toEqual([]);
  });
});
