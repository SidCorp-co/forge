// ISS-1251 c3: what a room agent's turn was given is recorded as a run's is, read off the composed
// brief: each room act card whose map line it holds, never an act a member's message only names.
//
// @direct-test-of packages/core/src/support/room-reaches.ts

import { describe, expect, it } from 'vitest';
import { mapLine } from './act-cards.js';
import { SUPPORT_MAP_ACTS } from './prompt.js';
import { cardsCarriedIn } from './room-reaches.js';

describe('the cards a room turn carried', () => {
  it('records each act whose map line the brief holds, at its card’s text', () => {
    const brief = ['You answer the group.', ...SUPPORT_MAP_ACTS.map(mapLine)].join('\n\n');
    const carried = cardsCarriedIn(brief);
    expect(carried.map((c) => c.ref).sort()).toEqual(
      SUPPORT_MAP_ACTS.map((a) => `support.${a}`).sort(),
    );
    for (const c of carried) {
      expect(c.kind).toBe('capability');
      expect(c.revision).toMatch(/^sha256:[0-9a-f]{16}$/);
    }
  });

  it('records no card a text only names', () => {
    expect(cardsCarriedIn('a member asks: why not support.member { thread }?')).toEqual([]);
  });
});
