// The REST cards of the doors a project's knowledge and setup are kept through (ISS-1251): memory,
// knowledge, lessons and the steward's notes, labels, the project document, its ecosystem links, and
// a reference source's citation.

import type { CapabilityCard } from '@forge/contracts/capability-cards';
import { REFERENCE_REST_CARD } from '@forge/contracts/references';
import { ECOSYSTEM_REST_CARDS } from '../ecosystem/index.js';
import { KNOWLEDGE_REST_CARDS } from '../knowledge/index.js';
import { LABEL_REST_CARDS } from '../labels/index.js';
import { LESSON_REST_CARDS } from '../lessons/index.js';
import { MEMORY_REST_CARDS } from '../memory/index.js';
import { PROJECT_CONFIG_REST_CARDS } from '../project-config/index.js';
import { STEWARD_REST_CARDS } from '../steward/index.js';
import { STEWARD_NOTE_REST_CARDS } from '../steward-notes/index.js';
import { ownedBy } from './owned-cards.js';

export const PROJECT_KNOWLEDGE_REST_CARDS: readonly CapabilityCard[] = [
  ...ownedBy('memory', MEMORY_REST_CARDS),
  ...ownedBy('knowledge', KNOWLEDGE_REST_CARDS),
  ...ownedBy('steward', STEWARD_REST_CARDS),
  ...ownedBy('steward-notes', STEWARD_NOTE_REST_CARDS),
  ...ownedBy('labels', LABEL_REST_CARDS),
  ...ownedBy('project-config', PROJECT_CONFIG_REST_CARDS),
  ...ownedBy('ecosystem', ECOSYSTEM_REST_CARDS),
  ...ownedBy('lessons', LESSON_REST_CARDS),
  ...ownedBy('references', {
    'POST /api/projects/:id/reference-sources/:source/citations': REFERENCE_REST_CARD,
  }),
];
