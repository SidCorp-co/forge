import { RUN_MACHINE } from '@forge/contracts/run-machine';
import { isLivePauseReason } from '@forge/contracts/run-standing';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { projectRoom, roomManager } from '../lib/rooms.js';
import { type KernelActor, transition } from '../lifecycle/index.js';

export {
  describePause,
  HUMAN_RESUMED_PAUSE_KINDS,
  isLivePauseReason,
  LIVE_PAUSE_REASON_KINDS,
  MACHINE_RESUMED_PAUSE_KINDS,
  type PauseDescription,
  type PauseReasonKind,
  type PauseResumer,
  pauseReasonFor,
  pauseResumesItself,
} from '@forge/contracts/run-standing';

export type PipelineRunRow = typeof pipelineRuns.$inferSelect;

export function broadcastRunStatus(run: PipelineRunRow): void {
  roomManager.publish(projectRoom(run.projectId), {
    event: 'pipeline_run.status_changed',
    data: {
      runId: run.id,
      projectId: run.projectId,
      issueId: run.issueId,
      status: run.status,
      kind: run.kind,
      currentStep: run.currentStep,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
  });
}

export async function pauseRun(args: {
  runId: string;
  /** Machine pause reason merged into `metadata.pauseReason`; omit for
   *  operator pauses (matchers must not auto-resume those). */
  pauseReason?: string | undefined;
  /** Who paused it; a machine pause is the system's. */
  actor?: KernelActor | undefined;
}): Promise<PipelineRunRow | null> {
  const [row] = (
    await transition(db, RUN_MACHINE, {
      to: 'paused',
      from: 'running',
      set: {
        updatedAt: new Date(),
        ...(args.pauseReason
          ? {
              metadata: sql`COALESCE(${pipelineRuns.metadata}, '{}'::jsonb) || jsonb_build_object('pauseReason', ${args.pauseReason}::text)`,
            }
          : {}),
      },
      where: eq(pipelineRuns.id, args.runId),
      reason: args.pauseReason ?? null,
      actor: args.actor ?? { type: 'system' },
      source: 'run-pause',
    })
  ).rows;
  if (!row) return null;
  broadcastRunStatus(row);
  return row;
}

async function resumeRunsWhere(
  where: SQL | undefined,
  opts: { actor?: KernelActor | undefined } = {},
): Promise<PipelineRunRow[]> {
  const { rows } = await transition(db, RUN_MACHINE, {
    to: 'running',
    from: 'paused',
    set: {
      updatedAt: new Date(),
      metadata: sql`COALESCE(${pipelineRuns.metadata}, '{}'::jsonb) - 'pauseReason'`,
    },
    where,
    actor: opts.actor ?? { type: 'system' },
    source: 'run-resume',
  });
  for (const row of rows) {
    broadcastRunStatus(row);
  }
  return rows;
}

/** CAS `paused → running` for one run. Null when the run was not paused. */
export async function resumeRun(args: {
  runId: string;
  actor?: KernelActor | undefined;
}): Promise<PipelineRunRow | null> {
  const rows = await resumeRunsWhere(eq(pipelineRuns.id, args.runId), { actor: args.actor });
  return rows[0] ?? null;
}

export interface OrphanedPauseResult {
  /** Paused runs carrying a machine reason whose kind is gone from this build. */
  detected: number;
  resumed: number;
}

/**
 * Resume every run frozen by a pause mechanism this build no longer has.
 *
 * A run paused with no `pauseReason` is an OPERATOR pause and is never
 * touched — only a human resumes those.
 */
export async function resumeOrphanedPauses(): Promise<OrphanedPauseResult> {
  const rows = await db
    .select({
      id: pipelineRuns.id,
      projectId: pipelineRuns.projectId,
      issueId: pipelineRuns.issueId,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.status, 'paused'),
        sql`${pipelineRuns.metadata} ->> 'pauseReason' IS NOT NULL`,
      ),
    );

  let detected = 0;
  let resumed = 0;
  for (const row of rows) {
    const reason = (row.metadata as Record<string, unknown> | null)?.pauseReason;
    const text = typeof reason === 'string' && reason !== '' ? reason : null;
    if (text === null || isLivePauseReason(text)) continue;
    detected += 1;
    const [freed] = await resumeRunsWhere(eq(pipelineRuns.id, row.id));
    if (!freed) continue;
    resumed += 1;
    logger.warn(
      { runId: row.id, projectId: row.projectId, issueId: row.issueId, pauseReason: text },
      'run-pause: resumed a run frozen by a retired pause mechanism',
    );
  }
  return { detected, resumed };
}
