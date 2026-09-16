// What "autonomous" IS, with no dispatcher attached.
//
// Two domains ask these questions: the dispatcher enqueues by them, and
// `issues/apply-transition.ts` rewrites a status by them. So they live in a
// module with no runtime imports at all — `autonomous-dispatch.ts` reaches
// pg-boss through the enqueue helper, and a caller that only wants to ASK
// whether a project is autonomous must not boot the queue to find out.

import { type IssueStatus, issueStatuses, type JobType } from '../db/schema.js';
import type { PipelineConfig } from './pipeline-config-schema.js';

/** The status at which the driver is handed the issue. */
export const AUTONOMOUS_ENTRY_STATUS: IssueStatus = 'open';

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

/**
 * What the autonomous driver wants done for an issue that just landed on
 * `status`: a single drive job at the entry status, and nothing anywhere else.
 *
 * It lives beside the constants rather than in `autonomous-dispatch.ts` for
 * the reason this module exists at all — asking whether a status dispatches
 * must not boot the queue. `status-assertions.ts` asks exactly that.
 */
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

/** Where the driver's work ends and the issue run closes with it. */
export const AUTONOMOUS_TERMINAL_STATUSES: readonly IssueStatus[] = ['closed', 'dropped'] as const;

export const AUTONOMOUS_INFLIGHT_STATUSES: readonly IssueStatus[] =
  AUTONOMOUS_DRIVER_STATUSES.filter(
    (s) =>
      s !== AUTONOMOUS_ENTRY_STATUS &&
      s !== AUTONOMOUS_QUESTION_STATUS &&
      !AUTONOMOUS_TERMINAL_STATUSES.includes(s),
  );

/** Whether a human, not a master, decides when this project's work starts. */
export function isEntryGateClosed(cfg: PipelineConfig | null): boolean {
  const entry = cfg?.states?.open;
  return entry?.enabled === false || entry?.mode === 'manual';
}
