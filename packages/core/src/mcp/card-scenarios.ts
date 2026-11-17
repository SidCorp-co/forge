// Every capability card's scenarios (ISS-1251 §1, §5), one registry the card's `scenarios` names point
// into: each scenario a real situation an agent met at the card's door, quoted from where it was
// recorded, with what the bad use did and what the teaching must say for the good use
// (`lessons/scenario-replay.ts`). A card is replayed on its scenarios as an agent reads it: a room
// act's card under the room brief's map, which every room agent reads each turn; any other card alone.
// `card-scenarios.test.ts` replays every scenario on its card as this build serves it, so a card or a
// map line changed so that a scenario no longer holds fails the build naming it; the steward replays
// a lesson's change to a card the same way before adopting it.

import type { CapabilityCard } from '@forge/contracts/capability-cards';
import type { CardScenario, CardText } from '../lessons/index.js';
import { roomConductLines } from '../support/index.js';
import { CHANNEL_SCENARIOS } from './scenarios-channel.js';
import { CONFIG_SCENARIOS } from './scenarios-config.js';
import { DELIVERY_SCENARIOS } from './scenarios-delivery.js';
import { DESIGN_SCENARIOS } from './scenarios-design.js';
import { ECOSYSTEM_SCENARIOS } from './scenarios-ecosystem.js';
import { FEEDBACK_SCENARIOS } from './scenarios-feedback.js';
import { ISSUE_SCENARIOS } from './scenarios-issues.js';
import { KNOWLEDGE_SCENARIOS } from './scenarios-knowledge.js';
import { PERSON_SCENARIOS } from './scenarios-person.js';
import { PRODUCT_SCENARIOS } from './scenarios-product.js';
import { RELEASE_SCENARIOS } from './scenarios-release.js';
import { REQUIREMENT_SCENARIOS } from './scenarios-requirements.js';
import { ROOM_SCENARIOS } from './scenarios-room.js';
import { ROOM_ACT_SCENARIOS } from './scenarios-room-acts.js';
import { ROOM_WORK_SCENARIOS } from './scenarios-room-work.js';
import { SETUP_SCENARIOS } from './scenarios-setup.js';
import { SUPPORT_SCENARIOS } from './scenarios-support.js';

export const CARD_SCENARIOS: readonly CardScenario[] = [
  ...ROOM_SCENARIOS,
  ...ROOM_WORK_SCENARIOS,
  ...DELIVERY_SCENARIOS,
  ...PRODUCT_SCENARIOS,
  ...REQUIREMENT_SCENARIOS,
  ...FEEDBACK_SCENARIOS,
  ...RELEASE_SCENARIOS,
  ...ISSUE_SCENARIOS,
  ...ECOSYSTEM_SCENARIOS,
  ...CONFIG_SCENARIOS,
  ...DESIGN_SCENARIOS,
  ...SUPPORT_SCENARIOS,
  ...KNOWLEDGE_SCENARIOS,
  ...CHANNEL_SCENARIOS,
  ...SETUP_SCENARIOS,
  ...PERSON_SCENARIOS,
  ...ROOM_ACT_SCENARIOS,
];

/** A card's scenarios, in the order the registry holds them. */
export const scenariosOf = (cardId: string): CardScenario[] =>
  CARD_SCENARIOS.filter((s) => s.card === cardId);

/** What a card's audience reads every turn beside it: a room act's card is read under the room's map. */
export const contextOf = (card: Pick<CapabilityCard, 'id' | 'audience'>): string | undefined =>
  card.id.startsWith('support.') && card.audience.includes('bot')
    ? roomConductLines().join('\n')
    : undefined;

/** A card as a replay reads it: its scenarios, its text and what its audience reads beside it. */
export function cardTextOf(card: CapabilityCard): CardText {
  const context = contextOf(card);
  return {
    id: card.id,
    scenarios: scenariosOf(card.id),
    situations: card.situations,
    practice: card.practice,
    ...(card.redFlag ? { redFlag: card.redFlag } : {}),
    ...(context ? { context } : {}),
  };
}
