import { describe, expect, it } from 'vitest';
import { decideFire } from './fire.mjs';

const thresholds = { size: 3, minutes: 90, source: 'the plugin project file, train' };
const now = new Date('2026-09-29T12:00:00Z');
const at = (min) => new Date(now.getTime() - min * 60_000).toISOString();
const members = (n, min = 1) =>
  Array.from({ length: n }, (_, i) => ({ issue: `ISS-${i}`, arrivedAt: at(min) }));

describe('decideFire', () => {
  it.each([
    [{ minutes: 90, source: 's' }, /no `thresholds\.size`/],
    [{ size: 3, source: 's' }, /no `thresholds\.minutes`/],
    [{ size: 3, minutes: 90 }, /no `thresholds\.source`/],
    [undefined, /no `thresholds\.size` and no `thresholds\.minutes`/],
  ])('refuses %j by name and substitutes no default', (t, want) => {
    const r = decideFire({ members: members(5, 600), thresholds: t, now });
    expect(r.refusal).toMatch(want);
    expect(r.fired).toBeUndefined();
  });

  it('does not fire one member short of the size', () => {
    expect(decideFire({ members: members(2), thresholds, now }).fired).toBe(false);
  });

  it('fires on the size once it is reached', () => {
    const r = decideFire({ members: members(3), thresholds, now });
    expect(r.by).toEqual(['size (3 of 3)']);
  });

  it('fires on the wait at exactly the declared minutes, measured from arrival', () => {
    const r = decideFire({ members: [{ issue: 'ISS-1', arrivedAt: at(90) }], thresholds, now });
    expect(r.fired).toBe(true);
    expect(r.by).toEqual(['minutes (ISS-1 has waited 90 of 90)']);
  });

  it('does not fire a minute short of the wait', () => {
    const r = decideFire({ members: [{ issue: 'ISS-1', arrivedAt: at(89) }], thresholds, now });
    expect(r.fired).toBe(false);
  });

  it('fires on a critical member whatever the size and the wait say', () => {
    const one = [{ issue: 'ISS-7', arrivedAt: at(0), priority: 'critical' }];
    expect(decideFire({ members: one, thresholds, now }).by).toEqual(['critical (ISS-7)']);
  });

  it('refuses a window larger than its declared ceiling', () => {
    const r = decideFire({ members: members(5), thresholds: { ...thresholds, maxSize: 4 }, now });
    expect(r.refusal).toMatch(/holds 5 members and `thresholds\.maxSize` is 4: split it/);
  });

  it('refuses a ceiling below the size', () => {
    const r = decideFire({ members: members(1), thresholds: { ...thresholds, maxSize: 2 }, now });
    expect(r.refusal).toMatch(/must be a ceiling at or above `size` \(3\)/);
  });

  it.each([
    [
      { ...thresholds, size: 0 },
      '`thresholds.size` is declared as 0; it must be a positive whole number',
    ],
    [
      { ...thresholds, size: 2.5 },
      '`thresholds.size` is declared as 2.5; it must be a positive whole number',
    ],
    [
      { ...thresholds, minutes: -5 },
      '`thresholds.minutes` is declared as -5; it must be a positive number',
    ],
    [
      { ...thresholds, maxSize: 0 },
      '`thresholds.maxSize` is declared as 0; it must be a positive whole number',
    ],
  ])('refuses %j as a declared value that is not a threshold, not as an absent one', (t, want) => {
    const r = decideFire({ members: members(5, 600), thresholds: t, now });
    expect(r.refusal).toBe(want);
  });

  it('refuses a member that arrived after the time the window is judged at', () => {
    const r = decideFire({
      members: [{ issue: 'ISS-3', arrivedAt: '2026-09-29T12:30:00Z' }],
      thresholds,
      now,
    });
    expect(r.refusal).toBe(
      'ISS-3 arrived at 2026-09-29T12:30:00Z, after the time the window is judged at (2026-09-29T12:00:00.000Z), so its wait cannot be measured',
    );
  });

  it('refuses a member whose arrival cannot be read', () => {
    const r = decideFire({
      members: [{ issue: 'ISS-2', arrivedAt: 'yesterday' }],
      thresholds,
      now,
    });
    expect(r.refusal).toMatch(/ISS-2 carries no readable `arrivedAt`/);
  });
});
