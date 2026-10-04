import {
  AUTONOMOUS_DRIVER_STATUSES,
  AUTONOMOUS_ENTRY_STATUS,
  AUTONOMOUS_QUESTION_STATUS,
  ISSUE_TERMINAL_STATUSES,
} from '@forge/contracts/issue-machine';
import type { IssueStatus, JobType } from '../db/schema.js';
import { type ProjectPolicy } from './ports.js';

export { AUTONOMOUS_DRIVER_STATUSES, AUTONOMOUS_ENTRY_STATUS, AUTONOMOUS_QUESTION_STATUS };

export const AUTONOMOUS_JOB_TYPE: JobType = 'drive';

export function autonomousStepFor(
  status: IssueStatus,
): { type: JobType; skillName: string } | null {
  if (status !== AUTONOMOUS_ENTRY_STATUS) return null;
  return { type: AUTONOMOUS_JOB_TYPE, skillName: AUTONOMOUS_SKILL_NAME };
}

export const AUTONOMOUS_SKILL_NAME = 'issue-flow';

/** A project runs the driver exactly when it has a policy: the policy is what says how it runs. */
export function isAutonomous(policy: ProjectPolicy | null): policy is ProjectPolicy {
  return policy !== null;
}

export const AUTONOMOUS_INFLIGHT_STATUSES: readonly IssueStatus[] =
  AUTONOMOUS_DRIVER_STATUSES.filter(
    (s) =>
      s !== AUTONOMOUS_ENTRY_STATUS &&
      s !== AUTONOMOUS_QUESTION_STATUS &&
      !ISSUE_TERMINAL_STATUSES.includes(s),
  );

/** Whether a human, not a master, decides when this project's work starts. */
export function isEntryGateClosed(policy: ProjectPolicy | null): boolean {
  return policy?.intake.mode === 'manual';
}
