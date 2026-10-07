import { describe, expect, it } from 'vitest';
import { targetCountRefusal } from './rules.js';

describe('an item about a screen that also sends whereSeen (R-2)', () => {
  it('is refused under its own code at /whereSeen, not as a target count', () => {
    expect(targetCountRefusal({ screen: 'Settings' }, '/settings')).toMatchObject({
      code: 'FEEDBACK_SCREEN_TWICE',
      path: '/whereSeen',
    });
  });

  it('a blank whereSeen beside a screen is not a second naming', () => {
    expect(targetCountRefusal({ screen: 'Settings' }, '  ')).toBeNull();
  });

  it('whereSeen beside another target is where it was seen, and stands', () => {
    expect(targetCountRefusal({ issue: 'ISS-1' }, '/issues')).toBeNull();
  });

  it('two targets are still the target count', () => {
    expect(targetCountRefusal({ screen: 'Settings', issue: 'ISS-1' }, undefined)).toMatchObject({
      code: 'FEEDBACK_TARGET_NOT_ONE',
    });
  });
});
