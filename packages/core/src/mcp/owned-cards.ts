// A module's REST cards as the door catalog takes them (ISS-1251): each card judged and owned by the
// module it comes from, so a landing touching that module owes the card a re-check.

import type { CapabilityCard, CapabilityCardBody } from '@forge/contracts/capability-cards';
import { card } from '../prompt/index.js';

/** One module's cards, each owned by that module. */
export const ownedBy = (
  owner: string,
  cards: Readonly<Record<string, CapabilityCardBody>>,
): CapabilityCard[] => Object.entries(cards).map(([id, body]) => card(id, owner, body));
