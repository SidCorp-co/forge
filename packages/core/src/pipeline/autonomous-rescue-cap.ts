import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, jobs, pipelineRuns } from '../db/schema.js';
import { applyStatusTransition } from '../issues/index.js';
import { traceStep } from '../lib/error-tracking.js';
import { logger } from '../lib/logger.js';
import { AUTONOMOUS_JOB_TYPE, AUTONOMOUS_QUESTION_STATUS } from './autonomous-mode.js';
import { postCapReachedComment } from './autonomous-rescue-comment.js';
import { projectCreatorOf } from './ports.js';
import { emitPipelineWedge, rescueCapWedgeEntityId } from './wedge.js';

/**
 * Rescues of one run before the issue is handed to a human. Matches
 * `STAGE_STALL_CAP` deliberately — same question, same tolerance — but counts a
 * different thing, so it is declared separately rather than imported.
 */
const AUTONOMOUS_RESCUE_CAP = 3;

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
 * to skip. A failed check or a refused park throws, so the caller skips the row
 * rather than rescuing past the cap; a refused park is also raised as a wedge.
 */
export async function checkAutonomousRescueCap(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  reopenCount: number;
}): Promise<{ capped: boolean; runId: string | null }> {
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
  if (doneDriveJobs - state.doneDriveJobs > 1) return { capped: false, runId: run.id };
  if (state.count < AUTONOMOUS_RESCUE_CAP) return { capped: false, runId: run.id };

  try {
    await parkForHuman({ ...args, runId: run.id, doneDriveJobs });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    await emitPipelineWedge({
      projectId: args.projectId,
      issueId: args.issueId,
      hop: 'result',
      entity: 'run',
      entityId: rescueCapWedgeEntityId(run.id),
      reason: `rescue_cap_park_refused:${why}`,
      title: 'An issue used its rescues and could not be handed to a person',
      summary: `The driver was rescued ${AUTONOMOUS_RESCUE_CAP} times on this run without progress, and moving the issue to \`${AUTONOMOUS_QUESTION_STATUS}\` was refused: ${why}. It is no longer rescued; it waits here.`,
      nextStep: 'Read the refusal, settle what it names, then move the issue on by hand.',
      action: 'Settle the refused move; the issue is not being rescued.',
    });
    throw err;
  }
  return { capped: true, runId: run.id };
}

async function parkForHuman(args: {
  projectId: string;
  issueId: string;
  runId: string;
  status: IssueStatus;
  reopenCount: number;
  doneDriveJobs: number;
}): Promise<void> {
  const actorId = await projectCreatorOf(args.projectId);
  if (!actorId) throw new Error(`the project of issue ${args.issueId} has no owner to act as`);

  await applyStatusTransition(
    {
      id: args.issueId,
      projectId: args.projectId,
      status: args.status,
      reopenCount: args.reopenCount,
    },
    AUTONOMOUS_QUESTION_STATUS,
    { id: actorId, ownerId: actorId },
    {
      reason: 'autonomous_rescue_cap_reached',
      transitionReason: `The driver was rescued ${AUTONOMOUS_RESCUE_CAP} times on this run without progress, so it has stopped rather than try a fourth.`,
      needs:
        'Whether to send it back to the driver as it stands, or what to change first — answering returns the issue to the status it left.',
      waitingKind: 'needs_decision',
    },
  );

  await postCapReachedComment({
    issueId: args.issueId,
    authorId: actorId,
    fromStatus: args.status,
    cap: AUTONOMOUS_RESCUE_CAP,
    driveSessions: args.doneDriveJobs,
  });

  logger.warn(
    { issueId: args.issueId, runId: args.runId, from: args.status, cap: AUTONOMOUS_RESCUE_CAP },
    'autonomous-rescue-cap: rescues exhausted — parked the issue for a human',
  );
  traceStep({
    category: 'pipeline.autonomous.rescue_cap_reached',
    level: 'warning',
    data: { issueId: args.issueId, runId: args.runId, from: args.status },
  });
}

/** Charge one rescue to the run. Called only once a rescue actually happened. */
export async function recordAutonomousRescue(runId: string): Promise<void> {
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
      metadata: sql`COALESCE(${pipelineRuns.metadata}, '{}'::jsonb) || jsonb_build_object(${METADATA_KEY}::text, jsonb_build_object('count', ${count}::int, 'doneDriveJobs', ${doneDriveJobs}::int))`,
    })
    .where(eq(pipelineRuns.id, runId));
}
