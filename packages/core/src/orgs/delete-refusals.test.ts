// ISS-1229 r29, judge-84: a refused organization delete said "was not deleted" in the panel's title
// and again in its sentence. The title says what was not done; the sentence says why and what next.

import { describe, expect, it } from 'vitest';
import { heldDevicesRefusal, projectsStandRefusal } from './service.js';

describe('a refused organization delete', () => {
  it.each([
    ['one project', projectsStandRefusal(['Billing'])],
    ['two projects', projectsStandRefusal(['Billing', 'Ledger'])],
    [
      'one agent device',
      heldDevicesRefusal([{ id: 'a1', handle: 'ops' }], [{ device: 'box-1', ownerId: 'a1' }]),
    ],
    [
      'two agents',
      heldDevicesRefusal(
        [
          { id: 'a1', handle: 'ops' },
          { id: 'a2', handle: 'qa' },
        ],
        [
          { device: 'box-1', ownerId: 'a1' },
          { device: 'box-2', ownerId: 'a2' },
        ],
      ),
    ],
  ])('for %s says why and what next, never that it was not deleted', (_case, sentence) => {
    expect(sentence).not.toMatch(/not deleted/);
    expect(sentence).toMatch(/then delete the organization\.$/);
  });
});
