/**
 * ISS-626 — Stage-stall cap for the reconciler rescue path.
 *
 * Root cause of the 94-session spin loop (run 712a565a): a `plan` job was
 * dispatched to a device whose Claude CLI did NOT have the `forge-plan` skill
 * installed. The CLI treated `/forge-plan` as an unknown command, printed
 * "Unknown command: /forge-plan", and exited 0 / is_error=false / num_turns=0.
 * The runner trusts `is_error` (`succeeded = !is_error`), so the job was
 * recorded `done` — but no plan was written and the issue stayed at
 * `clarified`. The minute-cadence reconciler (reconciler.ts) then re-rescued
 * the still-stuck issue, minting a fresh no-op session every ~60s for ~93 min.
 *
 * Core-side (skill IS registered here — so the ISS-238 missing-skill guard,
 * which keys on a missing `skill_registrations` row, never fires) the only
 * observable signal is the pathology itself: the SAME stage completes `done`
 * repeatedly under one run without ever advancing the issue past it. This
 * guard caps that: after `STAGE_STALL_CAP` done jobs of the stage's job type
 * in the open run, it PAUSES the run (typed reason) + posts an operator-facing
 * comment instead of letting the reconciler re-enqueue a (K+1)th no-op.
 *
 * The true root fix (treat num_turns=0 / "Unknown command" as a runner-side
 * failure) ships on the runner release train; this is the deployable-now core
 * backstop that bounds session creation and surfaces the operator-fixable
 * cause (executing device missing the skill, or a skill that runs but never
 * advances status).
 */

import { and, count, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, comments, issues, jobs, pipelineRuns, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { hooks } from './hooks.js';
import { resolveJobTypeForStatus } from './skill-mapping.js';

/**
 * Consecutive `done` jobs of one stage type in a single run without the issue
 * advancing before the run is paused for review. 3 leaves generous headroom
 * for a couple of transient re-runs while still bounding the loop tightly
 * (the incident hit 94).
 */
export const STAGE_STALL_CAP = 3;

export const STAGE_STALL_REASON_PREFIX = 'stage_stalled:';

export function buildStageStalledReason(stage: IssueStatus): string {
  return `${STAGE_STALL_REASON_PREFIX}${stage}`;
}

function buildStageStalledCommentBody(args: {
  stage: IssueStatus;
  jobType: string;
  doneCount: number;
}): string {
  return [
    `🛑 **Pipeline halted at stage \`${args.stage}\`** — the stage keeps completing without advancing.`,
    '',
    `The \`${args.jobType}\` step has finished (\`done\`) ${args.doneCount} times in this run, yet the issue never left \`${args.stage}\`. That is a no-op loop: each attempt exits cleanly but does no work, so the reconciler keeps re-dispatching it.`,
    '',
    'Most likely cause:',
    `- The executing device's Claude CLI is **missing the \`forge-${args.jobType}\` skill** — the CLI then treats \`/forge-${args.jobType}\` as an unknown command, exits 0, and the job is recorded \`done\` with no work done. Verify the device has the project's skills synced (Skills page → push, or check the runner's \`.claude/skills\`).`,
    `- Or the skill runs but never performs the \`${args.stage}\` status transition.`,
    '',
    'Pipeline paused for review. Resume the run once the executing device has the skill (or the skill is fixed).',
  ].join('\n');
}

export interface StageStallCheckInput {
  projectId: string;
  issueId: string;
  status: IssueStatus;
}

/**
 * Decide whether the reconciler should refuse to re-enqueue this stuck issue
 * because its stage is stalling in a no-op loop.
 *
 * Returns `{ stalled: true }` when the caller must SKIP re-enqueue:
 *  - the open run is already paused with a `stage_stalled:` reason, or
 *  - the stage's job type has completed `done` >= STAGE_STALL_CAP times in the
 *    open run (in which case this call effectively pauses the run + comments).
 *
 * Returns `{ stalled: false }` for the normal rescue path (genuine crash-mid-
 * dispatch has zero done jobs of the type → count 0 → not stalled).
 */
export async function checkStageStallAndPause(
  input: StageStallCheckInput,
): Promise<{ stalled: boolean }> {
  try {
    return await checkStageStallAndPauseInner(input);
  } catch (err) {
    // FAIL-OPEN: a guard error must never block a legitimate reconciler rescue.
    logger.error(
      { err, issueId: input.issueId, status: input.status },
      'stage-stall-guard: check failed, failing open (allowing re-enqueue)',
    );
    return { stalled: false };
  }
}

async function checkStageStallAndPauseInner(
  input: StageStallCheckInput,
): Promise<{ stalled: boolean }> {
  const jobMap = resolveJobTypeForStatus(input.status);
  if (!jobMap) return { stalled: false }; // human-gated status — nothing to cap

  // Find the issue's non-terminal run (running or paused). Terminal runs are
  // left alone; a missing run means there's nothing to pause.
  const [run] = await db
    .select({
      id: pipelineRuns.id,
      status: pipelineRuns.status,
      currentStep: pipelineRuns.currentStep,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.issueId, input.issueId),
        eq(pipelineRuns.kind, 'issue'),
        eq(pipelineRuns.status, 'running'),
      ),
    )
    .limit(1);

  if (!run) {
    // No running run. If one is paused with our stall reason, keep refusing
    // re-enqueue (idempotent — no duplicate comment).
    const [paused] = await db
      .select({ metadata: pipelineRuns.metadata })
      .from(pipelineRuns)
      .where(
        and(
          eq(pipelineRuns.issueId, input.issueId),
          eq(pipelineRuns.kind, 'issue'),
          eq(pipelineRuns.status, 'paused'),
        ),
      )
      .limit(1);
    const reason = (paused?.metadata as Record<string, unknown> | null)?.pauseReason;
    return {
      stalled: typeof reason === 'string' && reason.startsWith(STAGE_STALL_REASON_PREFIX),
    };
  }

  const [row] = await db
    .select({ n: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.issueId, input.issueId),
        eq(jobs.type, jobMap.type),
        eq(jobs.status, 'done'),
        eq(jobs.pipelineRunId, run.id),
      ),
    );
  const doneCount = row?.n ?? 0;
  if (doneCount < STAGE_STALL_CAP) return { stalled: false };

  // Effective pause (idempotent via WHERE status='running').
  const reason = buildStageStalledReason(input.status);
  const updated = await db
    .update(pipelineRuns)
    .set({
      status: 'paused',
      // COALESCE + merge so we never clobber sibling metadata keys (mirrors
      // missing-skill-guard.pausePipelineRunMissingSkill).
      metadata: sql`COALESCE(${pipelineRuns.metadata}, '{}'::jsonb) || jsonb_build_object('pauseReason', ${reason}::text)`,
      updatedAt: new Date(),
    })
    .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, 'running')))
    .returning({ id: pipelineRuns.id });

  logger.warn(
    {
      projectId: input.projectId,
      issueId: input.issueId,
      stage: input.status,
      jobType: jobMap.type,
      doneCount,
      runId: run.id,
      effectivePause: updated.length > 0,
    },
    'stage-stall-guard: stage completed >= cap times without advancing — pausing run, refusing re-enqueue',
  );

  if (updated.length > 0) {
    await hooks.emit('pipelineRunStatusChanged', {
      runId: run.id,
      projectId: input.projectId,
      issueId: input.issueId,
      kind: 'issue',
      fromStatus: 'running',
      toStatus: 'paused',
      currentStep: run.currentStep,
    });
    await postStageStalledComment({
      projectId: input.projectId,
      issueId: input.issueId,
      stage: input.status,
      jobType: jobMap.type,
      doneCount,
    });
  }

  return { stalled: true };
}

async function postStageStalledComment(args: {
  projectId: string;
  issueId: string;
  stage: IssueStatus;
  jobType: string;
  doneCount: number;
}): Promise<void> {
  const [row] = await db
    .select({ createdBy: projects.createdBy })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, args.issueId))
    .limit(1);
  if (!row?.createdBy) return;
  try {
    await db.insert(comments).values({
      issueId: args.issueId,
      authorId: row.createdBy,
      body: buildStageStalledCommentBody({
        stage: args.stage,
        jobType: args.jobType,
        doneCount: args.doneCount,
      }),
      isAi: true,
    } as never);
  } catch (err) {
    logger.warn(
      { err, issueId: args.issueId, stage: args.stage },
      'stage-stall-guard: failed to post comment, continuing',
    );
  }
}
