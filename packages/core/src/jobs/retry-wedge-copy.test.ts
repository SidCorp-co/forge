/** ISS-1229 r11: the empty-pool notice counts runners as a person does — never "all 1" or "all 2". */

import { describe, expect, it } from 'vitest';
import { wedgeCopy } from './capacity-fleet.js';

describe('the empty-pool notice, counting the runners it names', () => {
  it.each([
    [1, 'its one runner has hit an account limit', 'its one runner is online but running'],
    [
      2,
      'both of its runners have hit an account limit',
      'both of its runners are online but running',
    ],
    [
      3,
      'all 3 of its runners have hit an account limit',
      'all 3 of its runners are online but running',
    ],
  ])('at %i', (n, limited, tooOld) => {
    expect(wedgeCopy(true, n, 0, { scope: 'this project' }).summary).toContain(limited);
    expect(wedgeCopy(false, 0, n, { scope: 'this project' }).summary).toContain(tooOld);
  });
});

// ISS-1228 r22 (judge-71): two out-of-date runners were told to update "that host", one runner
// "those hosts". The remedy names as many hosts as the notice counted.
describe('the out-of-date remedy, agreeing with the runners it counted', () => {
  it('names that host for one runner', () => {
    const one = wedgeCopy(false, 0, 1, { scope: 'this project' });
    expect(one.action).toBe('update the runner on that host');
    expect(one.nextStep).toMatch(/^Update forge-runner on that host; .* once it reports/);
  });

  it.each([2, 3])('names those hosts for %i runners', (n) => {
    const many = wedgeCopy(false, 0, n, { scope: 'this project' });
    expect(many.action).toBe('update the runner on those hosts');
    expect(many.nextStep).toMatch(/^Update forge-runner on those hosts; .* once one reports/);
  });
});
