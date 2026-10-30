// What the merge check and the mark ask the cleanup ledger about a landing (REQ-79 r4 BC-5): the issue
// kernel imports no other context, so the composition root fills this at boot
// (`work-ports.ts:provideCleanupLandingPort`), as it does for `fail-return.ts`.

import type { MergeCheckRefusalCode, MergeCheckReport } from '@forge/contracts/merge-check';
import { portSlot } from '../lib/port-slot.js';

interface LandingAsk {
  issueId: string;
  projectId: string;
}

const slot = portSlot<{
  /** Why a change rated high may not land before a green cleanup, or null (`cleanup/service.ts`). */
  cleanupLandingRefusal: (
    args: LandingAsk & { report: MergeCheckReport },
  ) => Promise<{ code: MergeCheckRefusalCode; path: string; detail: string } | null>;
  /** Whether a mark of this issue owes a merge check for that rule. */
  cleanupOwesLandingCheck: (args: LandingAsk) => Promise<boolean>;
}>('issues cleanup-landing', 'provideCleanupLandingPort');
export const provideCleanupLandingPort = slot.provide;
export const cleanupLandingRefusal = slot.port('cleanupLandingRefusal');
export const cleanupOwesLandingCheck = slot.port('cleanupOwesLandingCheck');
