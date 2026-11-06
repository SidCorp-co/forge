// What the mark asks the cleanup ledger about a landing (REQ-79 BC-5): whether a change rated high owes
// a merge check, which records its rating and the debt it leaves for the audit and refuses nothing for
// the cleanup. The issue kernel imports no other context, so the composition root fills this at boot
// (`work-ports.ts:provideCleanupLandingPort`), as it does for `fail-return.ts`.

import { portSlot } from '../lib/port-slot.js';

interface LandingAsk {
  issueId: string;
  projectId: string;
}

const slot = portSlot<{
  /** Whether a mark of this issue owes a merge check: it is rated high (`cleanup/service.ts`). */
  cleanupOwesLandingCheck: (args: LandingAsk) => Promise<boolean>;
}>('issues cleanup-landing', 'provideCleanupLandingPort');
export const provideCleanupLandingPort = slot.provide;
export const cleanupOwesLandingCheck = slot.port('cleanupOwesLandingCheck');
