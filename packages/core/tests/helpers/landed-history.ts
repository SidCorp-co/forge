/**
 * adminhub-api's real `release/stg` history around ISS-5, and an ancestry reader answering from it,
 * for the landing tests (`landed-world.ts`). It imports nothing from `src` at runtime, because a test
 * file's mock of `shipped-earlier.js` loads it before the app is loaded; `pairKey` is spelled as
 * `runners/checkout-ancestry.ts:pairKey` spells it.
 */

import type { AncestryReader } from '../../src/release-batch/shipped-earlier-ancestry.js';

const pairKey = (p: { commit: string; release: string }) => `${p.commit}@${p.release}`;

/** adminhub-api `release/stg`: c168d8b, then ISS-5's branch head d9fd508, merged as f4e5fb6. */
export const C1 = 'c168d8bca2482c61b1ecfb39722bd75bd5bd2e90';
export const D9 = 'd9fd508d7fe071acfc596010fb2717563768cee6';
export const F4 = 'f4e5fb66700ba7b35c8c607c8f7309fc5980861a';
/** A later head of `release/stg`, holding the merge: it judges a newer build. */
export const LATER = 'aaaa0000000000000000000000000000000000a1';
/** A commit on no line `release/stg` holds. */
export const ASIDE = 'bbbb0000000000000000000000000000000000b2';

/** Each commit and every commit it holds, itself included. */
const HISTORY: Record<string, readonly string[]> = {
  [C1]: [C1],
  [D9]: [D9, C1],
  [F4]: [F4, D9, C1],
  [LATER]: [LATER, F4, D9, C1],
  [ASIDE]: [ASIDE],
};

export const reader: AncestryReader = {
  async ask(pairs) {
    const out = new Map<string, boolean | { unread: string }>();
    for (const p of pairs) {
      const held = HISTORY[p.release];
      out.set(
        pairKey(p),
        held ? held.includes(p.commit) : { unread: `no history for ${p.release}` },
      );
    }
    return out;
  },
  witness: () => ({ via: 'source-host' }),
};
