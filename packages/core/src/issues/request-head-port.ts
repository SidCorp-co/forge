// The head of a change request the host merged, with whether its tree is the landing's, which a merge
// mark records beside the landing it identified (ISS-1168, REQ-63 BC-6): the source host adapter owns
// the reading and the issue kernel imports no adapter, so the composition root fills this at boot
// (`work-ports.ts:provideRequestHeadPort`).

import type { MergedHead } from '@forge/contracts/landing-artifacts';
import { portSlot } from '../lib/port-slot.js';

const slot = portSlot<{
  /**
   * `head` read against `landing` on the project's host (`source-host/merged-head.ts:readMergedHead`):
   * null where there is no head, unread with why where the host cannot say, never guessed.
   */
  requestHeadOf: (
    projectId: string,
    head: string | null,
    landing: string,
  ) => Promise<MergedHead | null>;
}>('issues request-head', 'provideRequestHeadPort');
export const provideRequestHeadPort = slot.provide;
export const requestHeadOf = slot.port('requestHeadOf');
