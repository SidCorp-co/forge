// What "autonomous" IS, with no dispatcher attached.
//
// Two domains ask these questions: the dispatcher enqueues by them, and
// `issues/apply-transition.ts` rewrites a status by them. So they live in a
// module with no runtime imports at all — `autonomous-dispatch.ts` reaches
// pg-boss through the enqueue helper, and a caller that only wants to ASK
// whether a project is autonomous must not boot the queue to find out.

import type { IssueStatus, JobType } from '../db/schema.js';
import type { PipelineConfig } from './pipeline-config-schema.js';

/** The status at which the driver is handed the issue. */
export const AUTONOMOUS_ENTRY_STATUS: IssueStatus = 'open';

export const AUTONOMOUS_JOB_TYPE: JobType = 'drive';

/** Ships in the runner binary; never resolved from `skill_registrations`. */
export const AUTONOMOUS_SKILL_NAME = 'forge-drive';

export function isAutonomous(cfg: PipelineConfig | null): boolean {
  return cfg?.mode === 'autonomous';
}
