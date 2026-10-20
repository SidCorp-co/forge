import { and, eq, sql } from 'drizzle-orm';
import { forgeActor } from '../comments/forge-author.js';
import { db } from '../db/client.js';
import { agentSessions, type IssueStatus, jobs, pipelineRuns } from '../db/schema.js';
import { transitionIssueStatus } from '../issues/apply-transition.js';
import { logger } from '../logger.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { AUTONOMOUS_JOB_TYPE, AUTONOMOUS_QUESTION_STATUS } from './autonomous-mode.js';
import { postCapReachedComment, type RunSessionTally } from './autonomous-rescue-comment.js';

/**
 * Rescues of one run before the issue is handed to a human. Matches
 * `STAGE_STALL_CAP` deliberately — same question, same tolerance — but counts a
 * different thing, so it is declared separately rather than imported.
 */
export const AUTONOMOUS_RESCUE_CAP = 3;

/** The reason code the park stores, and the sentence a person reads for it wherever it is shown. */
export const RESCUE_CAP_REASON = 'autonomous_rescue_cap_reached';
export const RESCUE_CAP_SENTENCE = `Forge sent it back to its agent ${AUTONOMOUS_RESCUE_CAP} times on this run without it moving on, so it stopped and waits on your answer.`;

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

/** The run's agent sessions by how each ended, counted off their rows as the run lists them. */
async function tallyRunSessions(runId: string): Promise<RunSessionTally> {
  const [row] = await db
    .select({
      completed: sql<number>`count(*) FILTER (WHERE ${agentSessions.status} IN ('completed', 'completed_via_recovery'))::int`,
      failed: sql<number>`count(*) FILTER (WHERE ${agentSessions.status} = 'failed')::int`,
      stopped: sql<number>`count(*) FILTER (WHERE ${agentSessions.status} IN ('cancelled', 'cancelled_stale'))::int`,
      open: sql<number>`count(*) FILTER (WHERE ${agentSessions.status} IN ('idle', 'queued', 'running'))::int`,
    })
    .from(agentSessions)
    .where(eq(agentSessions.pipelineRunId, runId));
  return {
    completed: Number(row?.completed ?? 0),
    failed: Number(row?.failed ?? 0),
    stopped: Number(row?.stopped ?? 0),
    open: Number(row?.open ?? 0),
  };
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
    if (doneDriveJobs - state.doneDriveJobs > 1) return { capped: false, runId: run.id };
    if (state.count < AUTONOMOUS_RESCUE_CAP) return { capped: false, runId: run.id };

    await parkForHuman({ ...args, runId: run.id });
    return { capped: true, runId: run.id };
  } catch (err) {
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
  const actor = await forgeActor(db);
  await transitionIssueStatus(
    {
      id: args.issueId,
      projectId: args.projectId,
      status: args.status,
      reopenCount: args.reopenCount,
    },
    AUTONOMOUS_QUESTION_STATUS,
    actor,
    {
      reason: RESCUE_CAP_REASON,
      transitionReason: RESCUE_CAP_SENTENCE,
      needs:
        'Whether to send it back to the driver as it stands, or what to change first — answering returns the issue to open.',
      skip: true,
    },
  );

  await postCapReachedComment({
    issueId: args.issueId,
    fromStatus: args.status,
    cap: AUTONOMOUS_RESCUE_CAP,
    sessions: await tallyRunSessions(args.runId),
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
        metadata: sql`COALESCE(${pipelineRuns.metadata}, '{}'::jsonb) || jsonb_build_object(${METADATA_KEY}::text, jsonb_build_object('count', ${count}::int, 'doneDriveJobs', ${doneDriveJobs}::int))`,
      })
      .where(eq(pipelineRuns.id, runId));
  } catch (err) {
    logger.error({ err, runId }, 'autonomous-rescue-cap: could not record the rescue');
  }
}
