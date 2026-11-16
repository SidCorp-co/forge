// The capability cards of the REST doors beyond the orientation's (ISS-1251), each written in its
// module's own `cards.ts` beside its routes, keyed by the door as the published contract lists it,
// and gathered here for the door catalog (`door-catalog.ts:servedDoorCatalog`). The module a card
// comes from is its owner, so a landing touching that module owes the card a re-check. A card that
// does not stand refuses the module's load, naming it (`prompt/facts/affordance-cards.ts:card`).

import type { CapabilityCard, CapabilityCardBody } from '@forge/contracts/capability-cards';
import { CLEANUP_REST_CARDS } from '../cleanup/index.js';
import { ECOSYSTEM_REST_CARDS } from '../ecosystem/index.js';
import { INTEGRATION_DOOR_REST_CARDS } from '../integration-door/index.js';
import { ISSUE_REST_CARDS } from '../issues/index.js';
import { KNOWLEDGE_REST_CARDS } from '../knowledge/index.js';
import { LABEL_REST_CARDS } from '../labels/index.js';
import { LESSON_REST_CARDS } from '../lessons/index.js';
import { MEMORY_REST_CARDS } from '../memory/index.js';
import { MONITORING_REST_CARDS } from '../monitoring/index.js';
import { PROJECT_CONFIG_REST_CARDS } from '../project-config/index.js';
import { card } from '../prompt/index.js';
import { QUESTION_REST_CARDS } from '../questions/index.js';
import { RELEASE_REST_CARDS } from '../release-batch/index.js';
import { SCHEDULE_REST_CARDS } from '../schedules/index.js';
import { STEWARD_REST_CARDS } from '../steward/index.js';
import { STEWARD_NOTE_REST_CARDS } from '../steward-notes/index.js';
import { WORKFLOW_REST_CARDS } from '../workflows/index.js';

/** One module's cards, each owned by that module. */
const ownedBy = (owner: string, cards: Readonly<Record<string, CapabilityCardBody>>) =>
  Object.entries(cards).map(([id, body]) => card(id, owner, body));

export const REST_CARDS: readonly CapabilityCard[] = [
  ...ownedBy('issues', ISSUE_REST_CARDS),
  ...ownedBy('release-batch', RELEASE_REST_CARDS),
  ...ownedBy('cleanup', CLEANUP_REST_CARDS),
  ...ownedBy('questions', QUESTION_REST_CARDS),
  ...ownedBy('integration-door', INTEGRATION_DOOR_REST_CARDS),
  ...ownedBy('schedules', SCHEDULE_REST_CARDS),
  ...ownedBy('monitoring', MONITORING_REST_CARDS),
  ...ownedBy('memory', MEMORY_REST_CARDS),
  ...ownedBy('knowledge', KNOWLEDGE_REST_CARDS),
  ...ownedBy('steward', STEWARD_REST_CARDS),
  ...ownedBy('steward-notes', STEWARD_NOTE_REST_CARDS),
  ...ownedBy('labels', LABEL_REST_CARDS),
  ...ownedBy('project-config', PROJECT_CONFIG_REST_CARDS),
  ...ownedBy('workflows', WORKFLOW_REST_CARDS),
  ...ownedBy('ecosystem', ECOSYSTEM_REST_CARDS),
  ...ownedBy('lessons', LESSON_REST_CARDS),
];
