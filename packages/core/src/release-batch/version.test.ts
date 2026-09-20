/**
 * ISS-1120 — the version rules, each planted with the value that would make it go red.
 *
 * The burn is the rule with no code of its own, so it is the one most easily lost: it holds
 * because `nextReleaseVersion` is handed the highest version ever CUT and has no way to know which
 * of them shipped. The two tests under "the burn" assert exactly that — hand it a failed
 * release's number and it steps over it — and they are what goes red if a later change filters
 * the store's read down to completed releases.
 */

import { describe, expect, it } from 'vitest';
import {
  compareReleaseVersions,
  FIRST_RELEASE_VERSION,
  formatReleaseVersion,
  nextReleaseVersion,
  parseReleaseVersion,
  type ReleaseVersion,
} from './version.js';

const v = (major: number, minor: number, patch: number): ReleaseVersion => ({
  major,
  minor,
  patch,
});

describe('parseReleaseVersion', () => {
  it('reads three dot-separated integers', () => {
    expect(parseReleaseVersion('0.1.0')).toEqual(v(0, 1, 0));
    expect(parseReleaseVersion('12.34.56')).toEqual(v(12, 34, 56));
  });

  it('refuses everything that is not that shape rather than guessing at it', () => {
    for (const bad of [
      '',
      '1',
      '1.2',
      '1.2.3.4',
      'v1.2.3',
      '1.2.3-rc1',
      '1.2.3+build',
      ' 1.2.3',
      '1.2.3 ',
      '01.2.x',
      '-1.2.3',
      '1.2.-3',
      'a.b.c',
    ]) {
      expect(parseReleaseVersion(bad), bad).toBeNull();
    }
  });

  it('refuses a number too large to compare exactly, rather than rounding it', () => {
    expect(parseReleaseVersion('0.99999999999999999999.0')).toBeNull();
  });

  it('round-trips through the format it writes', () => {
    expect(formatReleaseVersion(v(3, 14, 15))).toBe('3.14.15');
    expect(parseReleaseVersion(formatReleaseVersion(v(3, 14, 15)))).toEqual(v(3, 14, 15));
  });
});

describe('compareReleaseVersions', () => {
  it('orders by digit and not by the lexical order of the two strings', () => {
    // The whole reason this function exists: '0.10.0' < '0.9.0' as text, and is not as a version.
    expect(compareReleaseVersions(v(0, 10, 0), v(0, 9, 0))).toBeGreaterThan(0);
    expect('0.10.0' < '0.9.0').toBe(true);
  });

  it('breaks a tie on the next digit down', () => {
    expect(compareReleaseVersions(v(1, 0, 0), v(0, 99, 99))).toBeGreaterThan(0);
    expect(compareReleaseVersions(v(0, 4, 1), v(0, 4, 0))).toBeGreaterThan(0);
    expect(compareReleaseVersions(v(0, 4, 0), v(0, 4, 0))).toBe(0);
  });
});

describe('nextReleaseVersion — a new release', () => {
  it('cuts 0.1.0 for a project that has never cut one', () => {
    expect(nextReleaseVersion(null, null)).toEqual(FIRST_RELEASE_VERSION);
    expect(formatReleaseVersion(nextReleaseVersion(null, null))).toBe('0.1.0');
  });

  it('raises the minor digit, which is the digit the owner named', () => {
    expect(nextReleaseVersion(v(0, 4, 0), null)).toEqual(v(0, 5, 0));
  });

  it('resets the patch digit rather than carrying the re-cut forward', () => {
    // 0.4.2 is a release that was re-cut twice. The batch after it is 0.5.0, not 0.5.2.
    expect(nextReleaseVersion(v(0, 4, 2), null)).toEqual(v(0, 5, 0));
  });

  it('leaves the major digit alone, which nothing in this scheme moves', () => {
    expect(nextReleaseVersion(v(2, 7, 0), null)).toEqual(v(2, 8, 0));
    expect(nextReleaseVersion(v(0, 99, 0), null)).toEqual(v(0, 100, 0));
  });
});

describe('nextReleaseVersion — the burn', () => {
  it('steps over a failed release rather than offering its number back', () => {
    // 0.5.0 was cut and the release failed. The next NEW release is 0.6.0, and no argument this
    // function takes could make it 0.5.0 again: it is handed the highest ever cut, not the
    // highest that shipped. Filter the store's read down to completed releases and this goes red.
    const burned = v(0, 5, 0);
    expect(nextReleaseVersion(burned, null)).toEqual(v(0, 6, 0));
    expect(compareReleaseVersions(nextReleaseVersion(burned, null), burned)).toBeGreaterThan(0);
  });

  it('never returns a version at or below the highest already cut', () => {
    for (const highest of [v(0, 1, 0), v(0, 5, 0), v(1, 0, 3), v(2, 99, 1)]) {
      expect(
        compareReleaseVersions(nextReleaseVersion(highest, null), highest),
        formatReleaseVersion(highest),
      ).toBeGreaterThan(0);
    }
  });
});

describe('nextReleaseVersion — a re-cut', () => {
  it('raises the patch digit, which the owner reserved for exactly this', () => {
    expect(nextReleaseVersion(v(0, 5, 0), v(0, 5, 0))).toEqual(v(0, 5, 1));
  });

  it('leaves the minor digit where the failed release put it', () => {
    const recut = nextReleaseVersion(v(0, 5, 0), v(0, 5, 0));
    expect(recut.minor).toBe(5);
    expect(recut.major).toBe(0);
  });

  it('differs from the failed release only in the patch digit', () => {
    const failed = v(3, 12, 4);
    const recut = nextReleaseVersion(failed, failed);
    expect({ major: recut.major, minor: recut.minor }).toEqual({ major: 3, minor: 12 });
    expect(recut.patch).toBe(failed.patch + 1);
  });

  it('still lands above the failed release, so the burned number is not re-worn', () => {
    const failed = v(0, 5, 1);
    expect(compareReleaseVersions(nextReleaseVersion(failed, failed), failed)).toBeGreaterThan(0);
  });
});
