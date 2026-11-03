// ISS-919: when a home item last moved ranks Moving, and what nothing moved for more than
// `HOME_IDLE_DAYS` folds under Idle, a running item never; an item with no instant is refused loudly.
// @direct-test-of packages/core/src/product-progress/home-stage.ts

import { HOME_IDLE_DAYS } from '@forge/contracts/owner-home';
import { describe, expect, it } from 'vitest';
import { byLastMove, isIdle, lastMoveOf } from './home-stage.js';

const NOW = new Date('2026-11-03T00:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

describe('a home item’s last move', () => {
  it('is the latest instant its reads served, and refuses an item with none', () => {
    expect(lastMoveOf(daysAgo(9), null, daysAgo(2), undefined, daysAgo(5))).toBe(daysAgo(2));
    expect(() => lastMoveOf(null, undefined, '')).toThrow(/no instant it moved/);
  });

  it('makes an item idle only past the bound, and a running item never', () => {
    expect(isIdle(daysAgo(HOME_IDLE_DAYS), false, NOW)).toBe(false);
    expect(isIdle(daysAgo(HOME_IDLE_DAYS + 0.01), false, NOW)).toBe(true);
    expect(isIdle(daysAgo(90), true, NOW)).toBe(false);
  });

  it('ranks what moves before the idle, newest move first inside each', () => {
    const items = [
      { key: 'old-idle', idle: true, lastMovedAt: daysAgo(40) },
      { key: 'yesterday', idle: false, lastMovedAt: daysAgo(1) },
      { key: 'new-idle', idle: true, lastMovedAt: daysAgo(8) },
      { key: 'running-old', idle: false, lastMovedAt: daysAgo(30) },
      { key: 'today', idle: false, lastMovedAt: daysAgo(0) },
    ];
    expect([...items].sort(byLastMove).map((i) => i.key)).toEqual([
      'today',
      'yesterday',
      'running-old',
      'new-idle',
      'old-idle',
    ]);
  });
});
