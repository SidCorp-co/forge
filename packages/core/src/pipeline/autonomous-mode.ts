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

// cm:guard S1 of the published standard, and the ONLY declaration of it. The driver writes a KERNEL status; `needs_human` / `done` / `running` are render labels from packages/contracts/src/issue-vocabulary.ts, nothing on the write path translates them, and a skill that names one hands the agent a value `forge_issues` rejects — which is how 27 parks landed on `waiting`, a status answer-resume.ts never wakes.
// cm:edge lockstep -> packages/runner/skills/forge-drive/SKILL.md — the skill's "Statuses you may write" table must list exactly these; check-autonomous-transitions.mjs fails the build when they diverge
export const AUTONOMOUS_DRIVER_STATUSES: readonly IssueStatus[] = [
  'open',
  'in_progress',
  'needs_info',
  'closed',
  'dropped',
] as const;

export const AUTONOMOUS_JOB_TYPE: JobType = 'drive';

/** Ships in the runner binary; never resolved from `skill_registrations`. */
export const AUTONOMOUS_SKILL_NAME = 'forge-drive';

export function isAutonomous(cfg: PipelineConfig | null): boolean {
  return cfg?.mode === 'autonomous';
}
