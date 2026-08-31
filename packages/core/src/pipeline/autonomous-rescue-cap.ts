/**
 * ISS-890 — the bound on autonomous rescue, and the park it ends in.
 *
 * The staged cap (`stage-stall-guard.ts`, ISS-626) cannot see this loop: it
 * resolves a stage's job type through `resolveJobTypeForStatus`, derived from
 * `PIPELINE_STEPS`, where `drive` has no entry. On every autonomous project it
 * counts a job type that never exists, so its tail is 0 forever and the cap has
 * never once fired — ISS-880's run held three drive jobs with none in play.
 *
 * Swapping in `drive` does not fix it: on an autonomous project EVERY job is a
 * drive job, so "a done job of another type in between proves the issue
 * advanced" has nothing to cut the tail on, and three legitimate human-answer
 * cycles would pause a healthy run.
 *
 * So the count here is of RESCUES, not jobs — what this pass itself mints, held
 * on the run that owns them. Progress is read from evidence, not a timer: a
 * rescue mints exactly one drive job, so a run whose done-drive count grew by
 * MORE than one since the last rescue had a job from elsewhere (a human
 * answering at `needs_info`), which is proof the issue moved.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, jobs, pipelineRuns, projects } from '../db/schema.js';
import { applyStatusTransition } from '../issues/apply-transition.js';
import { logger } from '../logger.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { AUTONOMOUS_JOB_TYPE, AUTONOMOUS_QUESTION_STATUS } from './autonomous-mode.js';
import { postCapReachedComment } from './autonomous-rescue-comment.js';

/**
 * Rescues of one run before the issue is handed to a human. Matches
 * `STAGE_STALL_CAP` deliberately — same question, same tolerance — but counts a
 * different thing, so it is declared separately rather than imported.
 */
export const AUTONOMOUS_RESCUE_CAP = 3;

const METADATA_KEY = 'autonomousRescue';

interface RescueState {
  count: number;
  doneDriveJobs: number;
}

function readState(metadata: unknown): RescueState | null {
  const raw = (metadata as Record<string, unknown> | null)?.[METADATA_KEY];
  if (typeof raw !== 'object' || raw === null) return null;
  const { count, doneDriveJobs } = raw as Record<string, unknown>;
  if (typeof count !== 'number' || typeof doneDriveJobs !== 'number') return null;
  return { count, doneDriveJobs };
}

async function countDoneDriveJobs(runId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(
      and(
        eq(jobs.pipelineRunId, runId),
        eq(jobs.type, AUTONOMOUS_JOB_TYPE),
        eq(jobs.status, 'done'),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Has this run spent its rescues? Parks the issue at
 * `AUTONOMOUS_QUESTION_STATUS` and comments when it has, so the caller only has
 * to skip.
 */
export async function checkAutonomousRescueCap(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  reopenCount: number;
}): Promise<{ capped: boolean; runId: string | null }> {
  try {
    const [run] = await db
      .select({ id: pipelineRuns.id, metadata: pipelineRuns.metadata })
      .from(pipelineRuns)
      .where(
        and(
          eq(pipelineRuns.issueId, args.issueId),
          eq(pipelineRuns.kind, 'issue'),
          eq(pipelineRuns.status, 'running'),
        ),
      )
      .limit(1);
    if (!run) return { capped: false, runId: null };

    const state = readState(run.metadata);
    if (!state) return { capped: false, runId: run.id };

    const doneDriveJobs = await countDoneDriveJobs(run.id);
    // cm:guard MORE than one, never one: the rescue this state was written for mints exactly one drive job, so a growth of one is that job and nothing else — the loop. Reading `>= 1` as progress makes every loop look healthy and the cap never fires again.
    if (doneDriveJobs - state.doneDriveJobs > 1) return { capped: false, runId: run.id };
    if (state.count < AUTONOMOUS_RESCUE_CAP) return { capped: false, runId: run.id };

    await parkForHuman({ ...args, runId: run.id });
    return { capped: true, runId: run.id };
  } catch (err) {
    // cm:guard FAIL-OPEN, matching stage-stall-guard: a cap that throws must let the rescue through. A wedged issue nobody rescues is the defect this whole pass exists to remove, and it is worse than one extra drive session.
    logger.error(
      { err, issueId: args.issueId },
      'autonomous-rescue-cap: check failed, failing open (allowing rescue)',
    );
    return { capped: false, runId: null };
  }
}

async function parkForHuman(args: {
  projectId: string;
  issueId: string;
  runId: string;
  status: IssueStatus;
  reopenCount: number;
}): Promise<void> {
  const [row] = await db
    .select({ createdBy: projects.createdBy })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, args.issueId))
    .limit(1);
  const actorId = row?.createdBy;
  if (!actorId) {
    logger.warn(
      { issueId: args.issueId },
      'autonomous-rescue-cap: no project owner to act as, leaving the issue where it is',
    );
    return;
  }

  // cm:guard the ISSUE moves, not just the run. Pausing the run alone leaves the issue at its in-flight status, which the board renders as running — the shape orchestrator.ts warns about, and the wedge again with extra steps. `needs_info` is the one park a human answer restarts (pipeline/answer-resume.ts), so it is the only status here that names who is waited on AND has a way back.
  await applyStatusTransition(
    {
      id: args.issueId,
      projectId: args.projectId,
      status: args.status,
      reopenCount: args.reopenCount,
    },
    AUTONOMOUS_QUESTION_STATUS,
    { id: actorId, ownerId: actorId },
    // cm:why skip:true mirrors the in-flight wedge reset — a system park, not an agent asserting a plan or evidence exists
    { reason: 'autonomous_rescue_cap_reached', skip: true },
  );

  await postCapReachedComment({
    issueId: args.issueId,
    authorId: actorId,
    fromStatus: args.status,
    cap: AUTONOMOUS_RESCUE_CAP,
  });

  logger.warn(
    { issueId: args.issueId, runId: args.runId, from: args.status, cap: AUTONOMOUS_RESCUE_CAP },
    'autonomous-rescue-cap: rescues exhausted — parked the issue for a human',
  );
  if (isSentryEnabled()) {
    Sentry.addBreadcrumb({
      category: 'pipeline.autonomous.rescue_cap_reached',
      level: 'warning',
      data: { issueId: args.issueId, runId: args.runId, from: args.status },
    });
  }
}

/** Charge one rescue to the run. Called only once a rescue actually happened. */
export async function recordAutonomousRescue(runId: string): Promise<void> {
  try {
    const [run] = await db
      .select({ metadata: pipelineRuns.metadata })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId))
      .limit(1);

    const state = readState(run?.metadata);
    const doneDriveJobs = await countDoneDriveJobs(runId);
    const progressed = state !== null && doneDriveJobs - state.doneDriveJobs > 1;
    const count = state === null || progressed ? 1 : state.count + 1;

    await db
      .update(pipelineRuns)
      .set({
        // cm:edge protocol -> packages/core/src/pipeline/run-pause.ts — merge in SQL, never read-modify-write in JS: the same row carries `pauseReason`, and a minute-cadence writer that rebuilds the object clobbers whichever sibling key it did not read
        metadata: sql`COALESCE(${pipelineRuns.metadata}, '{}'::jsonb) || jsonb_build_object(${METADATA_KEY}::text, jsonb_build_object('count', ${count}::int, 'doneDriveJobs', ${doneDriveJobs}::int))`,
      })
      .where(eq(pipelineRuns.id, runId));
  } catch (err) {
    logger.error({ err, runId }, 'autonomous-rescue-cap: could not record the rescue');
  }
}
