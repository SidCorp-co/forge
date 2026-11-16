// The REST cards of the Product's doors (ISS-1251): a requirement, a feedback item, a question, a
// workflow's design and a comment or decision recorded on any of them.

import type { CapabilityCard } from '@forge/contracts/capability-cards';
import { COMMENT_REST_CARDS } from '../comments/index.js';
import { FEEDBACK_REST_CARDS } from '../feedback/index.js';
import { QUESTION_REST_CARDS } from '../questions/index.js';
import { REQUIREMENT_REST_CARDS } from '../requirements/index.js';
import { WORKFLOW_REST_CARDS } from '../workflows/index.js';
import { ownedBy } from './owned-cards.js';

export const PRODUCT_REST_CARDS: readonly CapabilityCard[] = [
  ...ownedBy('questions', QUESTION_REST_CARDS),
  ...ownedBy('workflows', WORKFLOW_REST_CARDS),
  ...ownedBy('comments', COMMENT_REST_CARDS),
  ...ownedBy('feedback', FEEDBACK_REST_CARDS),
  ...ownedBy('requirements', REQUIREMENT_REST_CARDS),
];
