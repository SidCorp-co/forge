import {
  AUTONOMOUS_DRIVER_STATUSES,
  AUTONOMOUS_ENTRY_STATUS,
  AUTONOMOUS_QUESTION_STATUS,
} from '@forge/contracts/issue-machine';
import type { IssueStatus } from '../db/schema.js';
import type { ProjectPolicy } from './ports.js';

export { AUTONOMOUS_DRIVER_STATUSES, AUTONOMOUS_ENTRY_STATUS, AUTONOMOUS_QUESTION_STATUS };

/** Only the entry status starts autonomous work; a master's run session takes it from there. */
export function isAutonomousEntry(status: IssueStatus): boolean {
  return status === AUTONOMOUS_ENTRY_STATUS;
}

/** A project runs the driver exactly when it has a policy: the policy is what says how it runs. */
export function isAutonomous(policy: ProjectPolicy | null): policy is ProjectPolicy {
  return policy !== null;
}

/** Whether a human, not a master, decides when this project's work starts. */
export function isEntryGateClosed(policy: ProjectPolicy | null): boolean {
  return policy?.intake.mode === 'manual';
}
