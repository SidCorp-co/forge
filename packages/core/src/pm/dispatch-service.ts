/**
 * The PM agent enqueuing a coder-skill job (triage / plan / code / review /
 * test / fix / release) for an issue.
 *
 * Routes to the **coder queue** via `enqueueJob` — NOT the PM queue — because
 * PM dispatch should drive the same skill pipeline a manual `/pipeline` click
 * does. PM-internal jobs (`type: 'pm'`) live in their own queue (Epic 2) and
 * are spawned by triggers, not here.
 *
 * Dispatchable types come from `STATUS_TO_JOB_TYPE`; `pm` and `custom` are
 * refused even though the `jobTypes` enum carries them.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  issues,
  type JobType,
  jobs,
  type ModelTier,
  pipelineRuns,
  projects,
} from '../db/schema.js';
import { enqueueJob } from '../jobs/enqueue.js';
import { buildJobPromptString } from '../jobs/prompt-string.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../logger.js';
import { openIssueRun } from '../pipeline/runs.js';
import {
  createProjectSkillResolver,
  inverseJobTypeToStatus,
  STATUS_TO_JOB_TYPE,
} from '../pipeline/skill-mapping.js';

const DISPATCHABLE_TYPES = new Set(
  Object.values(STATUS_TO_JOB_TYPE)
    .filter((m): m is NonNullable<typeof m> => m != null)
    .map((m) => m.type),
);

export type PmDispatchInput = {
  projectId: string;
  issueId: string;
  jobType: JobType;
  reason: string;
  payload?: Record<string, unknown> | undefined;
  modelTier?: ModelTier | undefined;
};

/** Enqueue one coder-skill job for an issue, on behalf of the PM agent. */
export async function dispatchPmJob(input: PmDispatchInput, createdBy: string) {
  if (!DISPATCHABLE_TYPES.has(input.jobType)) {
    throw new Error(
      `BAD_REQUEST: jobType "${input.jobType}" is not dispatchable via PM (allowed: ${[...DISPATCHABLE_TYPES].join(', ')})`,
    );
  }

  const [issue] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .limit(1);
  if (!issue) throw new Error('NOT_FOUND: issue not found');
  if (issue.projectId !== input.projectId) {
    throw new Error('BAD_REQUEST: issue belongs to a different project');
  }

  // cm:guard ISS-108 — manual mode means "only a human fires this stage", so the PM is refused here and the human-clicked /run-pipeline-step path is deliberately NOT: dropping this check is how an autonomous agent starts running the stages an operator asked to keep for themselves.
  const stageStatus = inverseJobTypeToStatus(input.jobType);
  if (stageStatus) {
    const [projectRow] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    const ac = (projectRow?.agentConfig ?? {}) as {
      pipelineConfig?: {
        states?: Record<string, { enabled?: boolean; mode?: 'auto' | 'manual' }>;
      };
    };
    const stageCfg = ac.pipelineConfig?.states?.[stageStatus];
    if (stageCfg?.mode === 'manual') {
      throw new Error('FORBIDDEN: STAGE_MANUAL_ONLY: stage is configured as manual-only');
    }
  }

  const resolver = createProjectSkillResolver(input.projectId);
  const resolved = stageStatus ? await resolver.resolve(stageStatus) : null;
  if (!resolved) {
    throw new Error('NOT_FOUND: no skill_registration for this jobType in this project');
  }

  // cm:guard the caller payload spreads FIRST and the system fields overwrite it. Reverse the order and a PM can set its own `dispatchedBy`, or point `skillName` at a skill the jobType does not map to — the payload is agent-authored, and this ordering is the only thing that makes the four fields below un-forgeable.
  const payload: Record<string, unknown> = {
    ...(input.payload ?? {}),
    skillName: resolved.skillName,
    promptString: buildJobPromptString({
      skillName: resolved.skillName,
      jobType: input.jobType,
      issueId: input.issueId,
    }),
    dispatchedBy: 'pm',
    reason: input.reason,
  };

  const run = await openIssueRun({ projectId: input.projectId, issueId: input.issueId });

  let insertedId: string | null = null;
  try {
    const [inserted] = await db
      .insert(jobs)
      .values({
        projectId: input.projectId,
        issueId: input.issueId,
        pipelineRunId: run.id,
        createdBy,
        type: input.jobType,
        payload,
        status: 'queued',
        modelTier: input.modelTier ?? null,
      })
      .returning({ id: jobs.id });
    insertedId = inserted?.id ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const [existing] = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.issueId, input.issueId),
            eq(jobs.type, input.jobType),
            inArray(jobs.status, ['queued', 'dispatched', 'running']),
          ),
        )
        .limit(1);
      return { ok: false, reason: 'already_active', jobId: existing?.id ?? null };
    }
    throw err;
  }
  if (!insertedId) throw new Error('forge_pm.dispatch: insert returned no row');

  try {
    await enqueueJob({ jobId: insertedId, issueId: input.issueId, type: input.jobType });
  } catch (err) {
    logger.error(
      { err, jobId: insertedId },
      'forge_pm.dispatch: pg-boss enqueue failed; row persisted',
    );
  }

  // cm:guard best-effort ON PURPOSE (ISS-102): the job is already queued by this point, so a failed lookup reports `pipelineRun: null` and never throws. Throwing here would tell the caller the dispatch failed when it succeeded, and the retry would queue a second job.
  let pipelineRun: { id: string; status: string } | null = null;
  try {
    const [runRow] = await db
      .select({ id: pipelineRuns.id, status: pipelineRuns.status })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, run.id))
      .limit(1);
    pipelineRun = runRow ?? null;
    if (!pipelineRun) {
      logger.warn(
        { runId: run.id, jobId: insertedId },
        'forge_pm.dispatch: parent pipeline_run vanished between openIssueRun and SELECT',
      );
    }
  } catch (err) {
    logger.warn(
      { err, runId: run.id, jobId: insertedId },
      'forge_pm.dispatch: pipeline_run lookup failed; returning pipelineRun=null',
    );
  }

  return {
    ok: true,
    jobId: insertedId,
    jobType: input.jobType,
    pipelineRun,
  };
}
