/**
 * ISS-1340 (FB-750) — the hold on an issue whose only landing is a commit its repository answered it
 * does not hold (`issues/landing-not-held.ts`). The sweep drafts no release for it, since none could
 * ever ship it, and the hold names the route, so the issue's standing says what clears it.
 */

import { type LandingNotHeld, NOT_HELD_ROUTE } from '../issues/index.js';
import type { ReleaseHold } from './hold.js';

export const RELEASE_LANDING_NOT_HELD = 'RELEASE_LANDING_NOT_HELD';

export function landingNotHeldHold(held: LandingNotHeld): ReleaseHold {
  return {
    code: RELEASE_LANDING_NOT_HELD,
    reason:
      `This issue's only landing is commit ${held.commit}, and its mark recorded the repository ` +
      `answering that it holds no such commit (${held.detail}). ${NOT_HELD_ROUTE}`,
    owes: 'agent',
    waitingFor: 'a mark at a commit this project’s repository holds',
  };
}
