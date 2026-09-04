import { describe, expect, it } from 'vitest';
import { effectiveDeviceCap, REPO_LOCK_MIN_RUNNER } from './device-cap.js';

// cm:guard this function is the only thing between a raised cap and a box whose runner cannot hold the repo-root lock. Every case below must keep resolving to 1 on the "not proven new enough" side; relaxing one to accept the configured value re-opens exactly the corruption the lock exists to prevent.
describe('effectiveDeviceCap', () => {
  it('honours the configured cap on a runner at the floor', () => {
    expect(effectiveDeviceCap(4, REPO_LOCK_MIN_RUNNER)).toBe(4);
  });

  it('honours it above the floor', () => {
    expect(effectiveDeviceCap(3, '0.11.0')).toBe(3);
  });

  it('holds an older runner at 1 however high the column is set', () => {
    expect(effectiveDeviceCap(8, '0.10.4')).toBe(1);
  });

  it.each([
    ['unknown', null],
    ['never reported', undefined],
    ['unparseable', 'nightly'],
    ['not three parts', '0.11'],
  ])('holds a box at 1 when the version is %s', (_label, version) => {
    expect(effectiveDeviceCap(6, version as string | null | undefined)).toBe(1);
  });

  it.each([
    ['null', null],
    ['zero', 0],
    ['negative', -3],
  ])('floors a %s column at 1 rather than stopping the box', (_label, configured) => {
    expect(effectiveDeviceCap(configured as number | null, '0.11.0')).toBe(1);
  });

  it('truncates a fractional column instead of comparing a float', () => {
    expect(effectiveDeviceCap(2.9, '0.11.0')).toBe(2);
  });
});
