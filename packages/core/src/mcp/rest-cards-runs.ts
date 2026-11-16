// The REST cards of the doors a run and its master work a run through (ISS-1251): a drive run's phase
// journal and handoffs, a job's cancel, a master's runs and questions from its box, and a preview.

import type { CapabilityCard } from '@forge/contracts/capability-cards';
import { DEVICE_REST_CARDS } from '../devices/index.js';
import { JOB_REST_CARDS } from '../jobs/index.js';
import { PIPELINE_REST_CARDS } from '../pipeline/index.js';
import { PREVIEW_REST_CARDS } from '../previews/index.js';
import { ownedBy } from './owned-cards.js';

export const RUN_REST_CARDS: readonly CapabilityCard[] = [
  ...ownedBy('pipeline', PIPELINE_REST_CARDS),
  ...ownedBy('jobs', JOB_REST_CARDS),
  ...ownedBy('devices', DEVICE_REST_CARDS),
  ...ownedBy('previews', PREVIEW_REST_CARDS),
];
