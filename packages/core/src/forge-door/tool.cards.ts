// The forge_feedback door's reading and follow-up actions' capability cards (ISS-1251): list, get,
// progress, verify, reopen and reply. `tool.ts:CARDS` spreads them beside submit's and door's.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const FEEDBACK_CARDS: Readonly<Record<string, CapabilityCardBody>> = {};
