import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { issues, jobTypes, jobs, modelTiers, pipelineRuns, projects } from '../../db/schema.js';
import { enqueueJob } from '../../jobs/enqueue.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { logger } from '../../logger.js';
import { openIssueRun } from '../../pipeline/runs.js';
import {
  STATUS_TO_JOB_TYPE,
  createProjectSkillResolver,
  inverseJobTypeToStatus,
} from '../../pipeline/skill-mapping.js';
import {
  type DeviceScopedMcpToolFactory,
  assertPmActor,
  zodToMcpSchema,
} from './lib.js';

/**
 * `forge_pm.dispatch` (Epic 3, ISS-19) — PM agent enqueues a coder-skill
 * job (triage / plan / code / review / test / fix / release) for an issue.
 *
 * Routes to the **coder queue** via `enqueueJob` — NOT the PM queue —
 * because PM dispatch should drive the same skill pipeline as a manual
 * `/pipeline` click. PM-internal jobs (`type: 'pm'`) live in their own
 * queue (Epic 2) and are spawned by triggers, not by this tool.
 *
 * Dispatchable types come from `STATUS_TO_JOB_TYPE`. `pm` and `custom` are
 * rejected even though they appear in the `jobTypes` enum.
 */

const DISPATCHABLE_TYPES = new Set(
  Object.values(STATUS_TO_JOB_TYPE)
    .filter((m): m is NonNullable<typeof m> => m != null)
    .map((m) => m.type),
);

const inputSchema = z
  .object({
    projectId: z.uuid(),
    issueId: z.uuid(),
    jobType: z.enum(jobTypes),
    reason: z.string().min(1).max(2000),
    payload: z.record(z.string(), z.unknown()).optional(),
    modelTier: z.enum(modelTiers).optional(),
  })
  .strict();

export const forgePmDispatchTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_pm.dispatch',
  description:
    'PM agent enqueues a coder-skill job (triage/plan/code/review/test/fix/release) for an issue. Routes to the coder queue; idempotent against active duplicates via the jobs_active_unique index. Returns `pipelineRun: { id, status }` for the parent run so the caller can drive forge_pipeline_runs.* lifecycle controls. Requires PM-actor capability.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    await assertPmActor(device, input.projectId);

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

    // ISS-108 — reject manual-mode stages for PM. Human-clicked /run-pipeline-step
    // still works because manual mode means "only a human can fire this stage".
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

    // ISS-108 — resolve skill name from skill_registrations rather than the
    // hardcoded `forge-${jobType}` convention.
    const resolver = createProjectSkillResolver(input.projectId);
    const resolved = stageStatus ? await resolver.resolve(stageStatus) : null;
    if (!resolved) {
      throw new Error('NOT_FOUND: no skill_registration for this jobType in this project');
    }

    // Caller payload spreads first so the canonical system fields below cannot
    // be impersonated — PM should never be able to forge a non-PM
    // `dispatchedBy` or override the skill mapping for the chosen jobType.
    const payload: Record<string, unknown> = {
      ...(input.payload ?? {}),
      skillName: resolved.skillName,
      dispatchedBy: 'pm',
      reason: input.reason,
    };

    // ISS-101 — PM dispatch always targets an issue; attach to its open run.
    const run = await openIssueRun({ projectId: input.projectId, issueId: input.issueId });

    let insertedId: string | null = null;
    try {
      const [inserted] = await db
        .insert(jobs)
        .values({
          projectId: input.projectId,
          issueId: input.issueId,
          pipelineRunId: run.id,
          createdBy: device.ownerId,
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
      await enqueueJob(insertedId);
    } catch (err) {
      logger.error(
        { err, jobId: insertedId },
        'forge_pm.dispatch: pg-boss enqueue failed; row persisted',
      );
    }

    // ISS-102 — surface the parent pipeline_run so the caller (PM agent /
    // automation) can pause/cancel through `forge_pipeline_runs.*` without a
    // separate lookup. Best-effort: a missing run row is logged and reported
    // as `null` rather than thrown — dispatch itself succeeded.
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
  },
});
