// The forge-beta keys an issue was ported from (ISS-982), which the mark reads a landing commit against
// (`merge-identity.ts:declaresBetaKey`): the beta port owns the pairs and the issue kernel imports no
// domain, so the composition root fills this at boot (`work-ports.ts:provideBetaProvenancePort`).

import { portSlot } from '../lib/port-slot.js';

const slot = portSlot<{
  /** Its own pair's key as a twin, and that of each Feedback item routed to it (`beta-port/index.ts:betaKeysOf`). */
  betaKeysOfIssue: (issueId: string) => Promise<string[]>;
}>('issues beta-provenance', 'provideBetaProvenancePort');
export const provideBetaProvenancePort = slot.provide;
export const betaKeysOfIssue = slot.port('betaKeysOfIssue');
