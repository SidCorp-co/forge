import { describe, expect, it } from 'vitest';
import { atLeastVersion, CLAIM_MIN_RUNNER as FLOOR } from './device-cap.js';

describe('the claim floor', () => {
  it('is 0.13.0: the first runner with no job-linked park of its own', () => {
    expect(FLOOR).toBe('0.13.0');
  });

  it('refuses a runner below the floor, and one that reports no version', () => {
    expect(atLeastVersion('0.12.9', FLOOR)).toBe(false);
    expect(atLeastVersion('0.11.0', FLOOR)).toBe(false);
    expect(atLeastVersion(null, FLOOR)).toBe(false);
    expect(atLeastVersion('0.13', FLOOR)).toBe(false);
  });

  it('serves the floor itself and anything above it', () => {
    expect(atLeastVersion('0.13.0', FLOOR)).toBe(true);
    expect(atLeastVersion('0.18.0', FLOOR)).toBe(true);
    expect(atLeastVersion('1.0.0', FLOOR)).toBe(true);
  });

  it('reads the a.b.c core of a pre-release or build suffix (ISS-1472)', () => {
    expect(atLeastVersion('0.18.0-dev.9', FLOOR)).toBe(true);
    expect(atLeastVersion('0.13.0-rc.1', FLOOR)).toBe(true);
    expect(atLeastVersion('0.18.0+build.5', FLOOR)).toBe(true);
    expect(atLeastVersion('0.12.9-dev.1', FLOOR)).toBe(false);
  });

  it('still refuses a string with no valid a.b.c core', () => {
    for (const v of [
      'x.y',
      '',
      '0.18',
      '0.18.0.1',
      '-dev.1',
      'a.b.c-dev.1',
      '1-2-3',
      '0.130',
      '01800',
      '1x2x3-dev',
    ]) {
      expect(atLeastVersion(v, FLOOR)).toBe(false);
    }
    expect(atLeastVersion(undefined, FLOOR)).toBe(false);
  });
});
