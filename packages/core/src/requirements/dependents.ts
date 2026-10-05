import type { ActorAgency } from '@forge/contracts/permissions';
import type { RequirementFeedbackItem } from '@forge/contracts/requirements';
import type { Tx } from '../db/client.js';
import type { ReadDoor } from '../feedback/index.js';
import { portSlot } from '../lib/port-slot.js';

/**
 * What feedback and suggestions answer for a requirement. Both build on requirements, so the
 * composition root hands them in at boot rather than this module importing them.
 */
export interface RequirementDependents {
  /** Every feedback item about the requirement, as its detail shows them. */
  feedbackOf(
    viewer: { userId: string; agency: ActorAgency },
    projectId: string,
    requirementId: string,
    door?: ReadDoor,
  ): Promise<RequirementFeedbackItem[]>;
  /** A newer revision is the head: every proposed suggestion on another base goes stale, in `tx`. */
  revised(tx: Tx, requirementId: string, head: number): Promise<unknown>;
}

const slot = portSlot<RequirementDependents>('requirements', 'provideRequirementDependents');
export const provideRequirementDependents = slot.provide;
export const requirementDependents = slot.get;
