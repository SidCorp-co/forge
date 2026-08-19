// Dispatch for a project running the agent-driven pipeline.
//
// The staged driver enqueues one job per status and lets the state machine
// walk the issue. The autonomous driver enqueues ONE job for the whole issue
// and then gets out of the way: the session owns every phase, so any later
// status change on that issue must produce no job at all.
//
// Nothing about run bookkeeping changes. An autonomous run is still
// `kind='issue'` with one open run per issue, because that kind is what the
// partial unique index, the issue-run reaper and the dispatch gates are keyed
// on — a new kind would mean a second copy of each, which is exactly the
// second orphan-hygiene mechanism this phase is not allowed to need.
//
// Design: docs/proposals/agent-driven-pipeline.md

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, type JobType, jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import type { Actor } from './activity.js';
import { ActiveJobConflictError, insertAndEnqueueJob } from './enqueue-helper.js';
import type { PipelineConfig } from './pipeline-config-schema.js';
import { openIssueRun } from './runs.js';

/** The status at which the driver is handed the issue. */
export const AUTONOMOUS_ENTRY_STATUS: IssueStatus = 'open';

export const AUTONOMOUS_JOB_TYPE: JobType = 'drive';

/** Ships in the runner binary; never resolved from `skill_registrations`. */
export const AUTONOMOUS_SKILL_NAME = 'forge-drive';

export function isAutonomous(cfg: PipelineConfig | null): boolean {
  return cfg?.mode === 'autonomous';
}

/**
 * What the autonomous driver wants done for an issue that just landed on
 * `status`: a single drive job at the entry status, and nothing anywhere else.
 */
// cm:guard returning `null` here must mean "enqueue nothing", NOT "no skill is registered" — the staged path reads a null resolution as a misconfiguration and pauses the run with a missing-skill comment, which on an autonomous project would park every issue the moment its agent moved it
export function autonomousStepFor(
  status: IssueStatus,
): { type: JobType; skillName: string } | null {
  if (status !== AUTONOMOUS_ENTRY_STATUS) return null;
  return { type: AUTONOMOUS_JOB_TYPE, skillName: AUTONOMOUS_SKILL_NAME };
}

function buildDrivePrompt(issueId: string, projectId: string): string {
  return [
    `Drive issue ${issueId} to completion with the \`${AUTONOMOUS_SKILL_NAME}\` skill.`,
    '',
    `Project: ${projectId}. Read the issue with \`forge_issues\`, and this project's`,
    '`projectFacts` with `forge_config` action `get` before phase 1 — the skills ship in the',
    'runner binary and know nothing about this repo.',
    '',
    'Declare every phase with `forge_phase` before you begin it. That declaration is your',
    'resume point: a session that dies restarts from the last phase you declared.',
  ].join('\n');
}

export interface DispatchAutonomousArgs {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  cfg: PipelineConfig | null;
  projectCreatedBy: string | null;
}

/**
 * Handle dispatch for an autonomous project. Returns `true` when this driver
 * owns the decision — including when the decision is to do nothing — so the
 * caller returns without walking the staged path.
 */
// cm:guard `true` on every status of an autonomous project, not just the entry one: falling through to the staged resolver at any other status would pause the run with a missing-skill comment the moment the agent moved its own issue
export async function dispatchAutonomous(args: DispatchAutonomousArgs): Promise<boolean> {
  if (!isAutonomous(args.cfg)) return false;

  const step = autonomousStepFor(args.status);
  if (!step) return true;

  const createdBy = args.actor.type === 'user' ? args.actor.id : (args.projectCreatedBy ?? null);
  if (!createdBy) {
    logger.warn(
      { projectId: args.projectId, issueId: args.issueId },
      'autonomous-dispatch: no createdBy available, refusing to enqueue',
    );
    return true;
  }

  const live = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, args.issueId))
    .limit(1);
  if (live[0]?.status !== args.status) return true;

  const run = await openIssueRun({ projectId: args.projectId, issueId: args.issueId });

  try {
    const { jobId } = await insertAndEnqueueJob({
      projectId: args.projectId,
      issueId: args.issueId,
      pipelineRunId: run.id,
      createdBy,
      type: step.type,
      skillName: step.skillName,
      promptString: buildDrivePrompt(args.issueId, args.projectId),
      payloadExtras: { mode: 'autonomous' },
      resolveRacingJobId: async () => {
        const [row] = await db
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.issueId, args.issueId), eq(jobs.type, step.type)))
          .limit(1);
        return row?.id ?? null;
      },
    });
    logger.info(
      { projectId: args.projectId, issueId: args.issueId, jobId },
      'autonomous-dispatch: drive job enqueued',
    );
  } catch (err) {
    // cm:why the duplicate is the unique index on (issueId, type) doing its job — one drive job per issue is the invariant, so a race losing here is correct, not an error
    if (err instanceof ActiveJobConflictError) return true;
    throw err;
  }
  return true;
}
