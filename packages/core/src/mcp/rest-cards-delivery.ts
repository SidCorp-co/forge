// The REST cards of the doors that move delivery (ISS-1251): an issue, a release, a cleanup, a
// change request or deploy through the integration door, a schedule and a monitoring binding.

import type { CapabilityCard } from '@forge/contracts/capability-cards';
import { CLEANUP_REST_CARDS } from '../cleanup/index.js';
import { INTEGRATION_DOOR_REST_CARDS } from '../integration-door/index.js';
import { ISSUE_REST_CARDS } from '../issues/index.js';
import { MONITORING_REST_CARDS } from '../monitoring/index.js';
import { RELEASE_REST_CARDS } from '../release-batch/index.js';
import { SCHEDULE_REST_CARDS } from '../schedules/index.js';
import { ownedBy } from './owned-cards.js';

export const DELIVERY_REST_CARDS: readonly CapabilityCard[] = [
  ...ownedBy('issues', ISSUE_REST_CARDS),
  ...ownedBy('release-batch', RELEASE_REST_CARDS),
  ...ownedBy('cleanup', CLEANUP_REST_CARDS),
  ...ownedBy('integration-door', INTEGRATION_DOOR_REST_CARDS),
  ...ownedBy('schedules', SCHEDULE_REST_CARDS),
  ...ownedBy('monitoring', MONITORING_REST_CARDS),
];
