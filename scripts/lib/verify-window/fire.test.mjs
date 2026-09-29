import { describe, expect, it } from 'vitest';
import { decideFire } from './fire.mjs';

const thresholds = { count: 3, waitHours: 6, source: 'forge knowledge get release-cohort' };
const now = new Date('2026-09-29T12:00:00Z');
const at = (h) => new Date(now.getTime() - h * 3_600_000).toISOString();
const members = (n, hours = 1) =>
  Array.from({ length: n }, (_, i) => ({ issue: `ISS-${i}`, arrivedAt: at(hours) }));

describe('decideFire', () => {
  it.each([
    [{ waitHours: 6, source: 's' }, /no `thresholds\.count`/],
    [{ count: 3, source: 's' }, /no `thresholds\.waitHours`/],
    [{ count: 3, waitHours: 6 }, /no `thresholds\.source`/],
    [undefined, /no `thresholds\.count` and no `thresholds\.waitHours`/],
  ])('refuses %j by name and substitutes no default', (t, want) => {
    const r = decideFire({ members: members(5, 10), thresholds: t, now });
    expect(r.refusal).toMatch(want);
    expect(r.fired).toBeUndefined();
  });

  it('does not fire one member short of the count', () => {
    expect(decideFire({ members: members(2), thresholds, now }).fired).toBe(false);
  });

  it('fires on the count once it is reached', () => {
    const r = decideFire({ members: members(3), thresholds, now });
    expect(r.by).toEqual(['count (3 of 3)']);
  });

  it('fires on the wait at exactly the declared wait, measured from arrival', () => {
    const r = decideFire({ members: [{ issue: 'ISS-1', arrivedAt: at(6) }], thresholds, now });
    expect(r.fired).toBe(true);
    expect(r.by[0]).toMatch(/^wait \(ISS-1 has waited 6\.0h of 6h\)$/);
  });

  it('does not fire a minute short of the wait', () => {
    const r = decideFire({
      members: [{ issue: 'ISS-1', arrivedAt: at(6 - 1 / 60) }],
      thresholds,
      now,
    });
    expect(r.fired).toBe(false);
  });

  it('fires on a critical member whatever the count and the wait say', () => {
    const r = decideFire({
      members: [{ issue: 'ISS-7', arrivedAt: at(0), priority: 'critical' }],
      thresholds,
      now,
    });
    expect(r.by).toEqual(['critical (ISS-7)']);
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
