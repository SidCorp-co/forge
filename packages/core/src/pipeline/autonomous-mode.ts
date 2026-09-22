import { type IssueStatus, issueStatuses, type JobType } from '../db/schema.js';
import { ISSUE_TERMINAL_STATUSES } from '../issues/status-sets.js';
import type { PipelineConfig } from './pipeline-config-schema.js';

/** The status at which the driver is handed the issue. */
export const AUTONOMOUS_ENTRY_STATUS: IssueStatus = 'open';

/** The status an issue rests at when its code has landed and the release has not been taken. */
export const AUTONOMOUS_RELEASE_STATUS: IssueStatus = 'awaiting_release';

/** The one park the driver may enter, and the only one a human answer restarts. */
export const AUTONOMOUS_QUESTION_STATUS: IssueStatus = 'needs_info';

export const AUTONOMOUS_DRIVER_STATUSES: readonly IssueStatus[] = [
  'open',
  'in_progress',
  'needs_info',
  'closed',
  'dropped',
] as const;

export const AUTONOMOUS_JOB_TYPE: JobType = 'drive';

export function autonomousStepFor(
  status: IssueStatus,
): { type: JobType; skillName: string } | null {
  if (status !== AUTONOMOUS_ENTRY_STATUS) return null;
  return { type: AUTONOMOUS_JOB_TYPE, skillName: AUTONOMOUS_SKILL_NAME };
}

const TERMINAL_FOR_BACKLOG: readonly IssueStatus[] = ['releasing'] as const;

export const BACKLOG_ADMISSIBLE_STATUSES: readonly IssueStatus[] = issueStatuses.filter(
  (s) => !AUTONOMOUS_DRIVER_STATUSES.includes(s) && !TERMINAL_FOR_BACKLOG.includes(s),
);

export const AUTONOMOUS_SKILL_NAME = 'issue-flow';

export function isAutonomous(cfg: PipelineConfig | null): boolean {
  return cfg !== null;
}

export const AUTONOMOUS_INFLIGHT_STATUSES: readonly IssueStatus[] =
  AUTONOMOUS_DRIVER_STATUSES.filter(
    (s) =>
      s !== AUTONOMOUS_ENTRY_STATUS &&
      s !== AUTONOMOUS_QUESTION_STATUS &&
      !ISSUE_TERMINAL_STATUSES.includes(s),
  );

/** Whether a human, not a master, decides when this project's work starts. */
export function isEntryGateClosed(cfg: PipelineConfig | null): boolean {
  const entry = cfg?.states?.open;
  return entry?.enabled === false || entry?.mode === 'manual';
}

/** Whether this project's release is taken without a person acting — ISS-1189. Absent is `manual`:
 *  the issue STOPS at `awaiting_release` and waits, which is the rung doing its job. */
export function releasesAutomatically(cfg: PipelineConfig | null): boolean {
  return cfg?.states?.awaiting_release?.mode === 'auto';
}
