// Where a landing's work sits on the module map (ISS-1256): the merge mark answers it, so the agent
// that just finished work reads, at that moment, what its module's tree holds and the call that
// records a term or rule there. The map is a read model over the labels module, which reads issues;
// the composition root fills this at boot (`work-ports.ts:provideIssueSidePorts`).

import type { ModuleLandingMap } from '@forge/contracts/module-map';
import { portSlot } from '../lib/port-slot.js';

const slot = portSlot<{
  /** `labels/module-map-read.ts:landingMapOf`. */
  landingMapOf: (projectId: string, issueId: string) => Promise<ModuleLandingMap>;
}>('issues module map', 'provideIssueModuleMapPort');
export const provideIssueModuleMapPort = slot.provide;
export const landingMapOf = slot.port('landingMapOf');
