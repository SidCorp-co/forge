/** ISS-1229 r11: the empty-pool notice counts runners as a person does — never "all 1" or "all 2". */

import { describe, expect, it } from 'vitest';
import { wedgeCopy } from './retry.js';

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
