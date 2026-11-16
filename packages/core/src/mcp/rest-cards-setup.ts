// The REST cards of the doors a project's rooms and setup are kept through (ISS-1251): a master's
// posts in its project's chat rooms, the shares it makes, a project skill, a runner and an archive.

import type { CapabilityCard } from '@forge/contracts/capability-cards';
import { PROJECT_REST_CARDS } from '../projects/index.js';
import { RUNNER_REST_CARDS } from '../runners/index.js';
import { SHARE_REST_CARDS } from '../shares/index.js';
import { SKILL_REST_CARDS } from '../skills/index.js';
import { SUPPORT_REST_CARDS } from '../support/index.js';
import { ownedBy } from './owned-cards.js';

export const SETUP_REST_CARDS: readonly CapabilityCard[] = [
  ...ownedBy('support', SUPPORT_REST_CARDS),
  ...ownedBy('shares', SHARE_REST_CARDS),
  ...ownedBy('skills', SKILL_REST_CARDS),
  ...ownedBy('runners', RUNNER_REST_CARDS),
  ...ownedBy('projects', PROJECT_REST_CARDS),
];
