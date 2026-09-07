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

// cm:guard the runId MUST be in the prompt — every phase endpoint takes it as a path segment, and the agent has no other way to learn its own run without spending a call on the pipeline-runs list route. It named `forge_phase` until 2026-09-02; the argument survived the move to REST, the tool did not.
// cm:guard the phase example IS the phase vocabulary: `phase_journal.phase` is free-form and no gate reads it, so whatever name this literal shows is what lands in the table. It read `phase-1` from 2026-09-02 until ISS-921 and 542 rows landed named `phase-0`..`phase-8`, which no reader can interpret and which do not mean the same step run to run. Keep a descriptive name, keep BOTH example lines on the SAME name, and never reintroduce an ordinal — `autonomous-dispatch.test.ts` fails on the digit, not on the wording.
// cm:guard CROSS-REPO coupling, so no `cm:edge` can hold it: the other side is `guides/skills/issue-flow/guide.md` in github.com/SidCorp-co/forge-plugin, which the agent reads via `forge guide issue-flow` (the bundled `SKILL.md` only delegates to it, re-checked 2026-09-06). that skill and this prompt are read in one context and must name ONE way to reach Forge and ONE status vocabulary. The bundled predecessor and this prompt disagreed until 2026-09-02 (skill said CLI, prompt said `forge_issues` / `forge_config` / `forge_phase`) and the agent believed the prompt — 4,806 `forge_step_start` and 4,268 `forge_step_handoff.write` MCP calls, every one on an autonomous project. The skill now lives in another repo, so nothing here can gate the pair; this line is the only record of the coupling.
function buildDrivePrompt(args: { issueId: string; projectId: string; runId: string }): string {
  return [
    `Drive issue ${args.issueId} to completion with the \`${AUTONOMOUS_SKILL_NAME}\` skill.`,
    '',
    `Project: ${args.projectId}. You reach Forge over the CLI — \`forge-runner api <path>\`,`,
    'authenticated by `$FORGE_PAT`, which the runner has already exported. Read the issue and',
    "this project's `projectFacts` before Phase 1; the skill is installed as a plugin and knows",
    'nothing about this repo:',
    '',
    `    forge-runner api issues/${args.issueId}`,
    `    forge-runner api projects/${args.projectId}/pipeline-config`,
    '',
    `Your run is ${args.runId}. Declare every phase before you begin it, and close it when it`,
    'ends. The declaration is your resume point: a session that dies restarts from the last phase',
    'you declared, so read the resume point FIRST — if it returns a phase, you are a resumed',
    'session and that is where you continue.',
    '',
    `    forge-runner api pipeline-runs/${args.runId}/resume-point`,
    `    forge-runner api pipeline-runs/${args.runId}/phases -X POST -d '{"phase":"understand"}'`,
    `    forge-runner api pipeline-runs/${args.runId}/phases/end -X POST -d '{"phase":"understand","attempt":1,"outcome":"ok"}'`,
    '',
    'Name the phase for the step it is, in words, never by its number: nothing can say what a row',
    'named `phase-4` was, and two runs need not have meant the same step by it. Reuse the name an',
    'earlier run used for the same step so the two aggregate — `understand`, `plan`, `code`,',
    '`review`, `ship` are already in the journal.',
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
 * The operator's gate on the entry stage — the one place a project says "hold
 * this issue for a human" without disabling the pipeline outright.
 */
// cm:guard only the two knobs that name a HUMAN decision belong here. The per-step `auto*` toggles (autoTriage, autoCode…) name stages this mode does not have, so reading one as "may the driver start" would invent a meaning the operator never set.
// cm:guard this is the ONLY entry gate since ISS-897 left one lane. `orchestrator.ts` used to re-apply the same two checks below the autonomous branch for the staged path, and a second copy is what let the two disagree about what "require a human" meant per project; every caller now reaches dispatch through `dispatchAutonomous`, so a check added here needs no twin and must not grow one.
export function isEntryGateClosed(cfg: PipelineConfig | null): boolean {
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
    // cm:guard stamp the entry status so `resolveStageOverrides` finds a stage at all: with no `stageStatus` the resolver returns EMPTY, and the operator's `states.open` deviceIds / disallowedTools / model are silently dropped for the ONE job type that runs unattended for an hour. Core already reads that same stage to decide whether the driver may start (`isEntryGateClosed`), so dropping the half that constrains it is the inconsistency, not the fix.
    payloadExtras: { mode: 'autonomous', stageStatus: AUTONOMOUS_ENTRY_STATUS },
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
