import type { JobType } from '../db/schema.js';

/**
 * SSOT for the runner-facing prompt string. Stamped at every issue-bound
 * job insert site (orchestrator, PM dispatch, escalation fallback) and
 * forwarded verbatim to the runner via the `job.assigned` WS event.
 *
 * Falls back to the conventional `forge-<jobType>` skill name when no
 * project-specific skill is registered for the stage, so manual escape
 * hatches keep working.
 */
export function buildJobPromptString(args: {
  skillName?: string | null;
  jobType: JobType;
  issueId: string;
}): string {
  const skill =
    args.skillName && args.skillName.length > 0 ? args.skillName : `forge-${args.jobType}`;
  return `/${skill} ${args.issueId}`;
}
