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
import {
  AUTONOMOUS_ENTRY_STATUS,
  AUTONOMOUS_JOB_TYPE,
  AUTONOMOUS_SKILL_NAME,
  isAutonomous,
} from './autonomous-mode.js';
import { ActiveJobConflictError, insertAndEnqueueJob } from './enqueue-helper.js';
import type { PipelineConfig, StageName } from './pipeline-config-schema.js';
import { openIssueRun } from './runs.js';

export {
  AUTONOMOUS_ENTRY_STATUS,
  AUTONOMOUS_JOB_TYPE,
  AUTONOMOUS_SKILL_NAME,
  isAutonomous,
} from './autonomous-mode.js';

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

// cm:guard the runId MUST be in the prompt — `forge_phase` takes it as a required argument, and without it the agent cannot make the call the skill tells it to make first. It has no other way to learn its own run.
function buildDrivePrompt(args: { issueId: string; projectId: string; runId: string }): string {
  return [
    `Drive issue ${args.issueId} to completion with the \`${AUTONOMOUS_SKILL_NAME}\` skill.`,
    '',
    `Project: ${args.projectId}. Read the issue with \`forge_issues\`, and this project's`,
    '`projectFacts` with `forge_config` action `get` before phase 1 — the skills ship in the',
    'runner binary and know nothing about this repo.',
    '',
    `Your run is ${args.runId}. Declare every phase with \`forge_phase\` before you begin it,`,
    'passing that runId. The declaration is your resume point: a session that dies restarts from',
    'the last phase you declared, so call `forge_phase` action `resume_point` first — if it',
    'returns a phase, you are a resumed session and that is where you continue.',
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
 * The operator's gate on the entry stage. In staged mode these two knobs sit
 * below the autonomous branch in `considerEnqueue` and so never applied here:
 * a project could set "require a human" and watch the driver start anyway.
 */
// cm:guard only the two knobs that name a HUMAN decision belong here. The per-step `auto*` toggles (autoTriage, autoCode…) name stages this mode does not have, so reading one as "may the driver start" would invent a meaning the operator never set.
// cm:edge lockstep -> packages/core/src/pipeline/orchestrator.ts — the staged path applies its own copy of these two checks (`stageCfg.enabled === false`, `stageCfg.mode === 'manual'`) after `dispatchAutonomous` returns false; both modes must gate on the same pair or "require human review" means two different things per project
function isEntryGateClosed(cfg: PipelineConfig | null): boolean {
  const entry = cfg?.states?.[AUTONOMOUS_ENTRY_STATUS as StageName];
  return entry?.enabled === false || entry?.mode === 'manual';
}

async function enqueueDriveJob(args: {
  projectId: string;
  issueId: string;
  createdBy: string;
  runId: string;
  step: { type: JobType; skillName: string };
}): Promise<string> {
  const { jobId } = await insertAndEnqueueJob({
    projectId: args.projectId,
    issueId: args.issueId,
    pipelineRunId: args.runId,
    createdBy: args.createdBy,
    type: args.step.type,
    skillName: args.step.skillName,
    promptString: buildDrivePrompt({
      issueId: args.issueId,
      projectId: args.projectId,
      runId: args.runId,
    }),
    payloadExtras: { mode: 'autonomous' },
    resolveRacingJobId: async () => {
      const [row] = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.issueId, args.issueId), eq(jobs.type, args.step.type)))
        .limit(1);
      return row?.id ?? null;
    },
  });
  logger.info(
    { projectId: args.projectId, issueId: args.issueId, jobId },
    'autonomous-dispatch: drive job enqueued',
  );
  return jobId;
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

  if (isEntryGateClosed(args.cfg)) {
    logger.info(
      { projectId: args.projectId, issueId: args.issueId },
      'autonomous-dispatch: entry stage is gated to a human, no drive job enqueued',
    );
    return true;
  }

  const createdBy = resolveCreatedBy(args.actor, args.projectCreatedBy);
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
    await enqueueDriveJob({
      projectId: args.projectId,
      issueId: args.issueId,
      createdBy,
      runId: run.id,
      step,
    });
  } catch (err) {
    // cm:why the duplicate is the unique index on (issueId, type) doing its job — one drive job per issue is the invariant, so a race losing here is correct, not an error
    if (err instanceof ActiveJobConflictError) return true;
    throw err;
  }
  return true;
}

function resolveCreatedBy(actor: Actor, projectCreatedBy: string | null): string | null {
  return actor.type === 'user' ? actor.id : (projectCreatedBy ?? null);
}

/**
 * The human pressing "Run" on an issue an autonomous project has gated. Throws
 * `ActiveJobConflictError` when a drive job is already live, so the route 409s
 * exactly as the staged manual path does.
 */
// cm:guard this bypasses `isEntryGateClosed` ON PURPOSE and must keep doing so — "Run" IS the human the gate is waiting for, and a button that refuses because a human is required would make `mode: 'manual'` a dead end with no way out but editing the config
export async function dispatchDriveManual(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  projectCreatedBy: string | null;
}): Promise<{ jobId: string; type: JobType }> {
  const step = autonomousStepFor(args.status);
  if (!step) {
    throw new Error(
      `AUTONOMOUS_NOT_AT_ENTRY: the driver is handed an issue at \`${AUTONOMOUS_ENTRY_STATUS}\`, this one is at \`${args.status}\``,
    );
  }
  const createdBy = resolveCreatedBy(args.actor, args.projectCreatedBy);
  if (!createdBy) throw new Error('NO_CREATED_BY: no user actor and no project owner to attribute');

  const run = await openIssueRun({ projectId: args.projectId, issueId: args.issueId });
  const jobId = await enqueueDriveJob({
    projectId: args.projectId,
    issueId: args.issueId,
    createdBy,
    runId: run.id,
    step,
  });
  return { jobId, type: step.type };
}
