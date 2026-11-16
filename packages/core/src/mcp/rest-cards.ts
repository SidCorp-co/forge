// The capability cards of the REST doors beyond the orientation's (ISS-1251), each written in its
// module's own `cards.ts` beside its routes, keyed by the door as the published contract lists it,
// and gathered here for the door catalog (`door-catalog.ts:servedDoorCatalog`) from three files by
// what the doors are for, so no one file reaches every module. The module a card comes from is its
// owner, so a landing touching that module owes the card a re-check. A card that does not stand
// refuses the module's load, naming it (`prompt/facts/affordance-cards.ts:card`).

import type { CapabilityCard } from '@forge/contracts/capability-cards';
import { DELIVERY_REST_CARDS } from './rest-cards-delivery.js';
import { PROJECT_KNOWLEDGE_REST_CARDS } from './rest-cards-knowledge.js';
import { PRODUCT_REST_CARDS } from './rest-cards-product.js';

export const REST_CARDS: readonly CapabilityCard[] = [
  ...DELIVERY_REST_CARDS,
  ...PRODUCT_REST_CARDS,
  ...PROJECT_KNOWLEDGE_REST_CARDS,
];
