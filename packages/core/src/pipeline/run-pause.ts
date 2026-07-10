/**
 * Single writer for the pause/resume axis of `pipeline_runs.status`
 * (running ⇄ paused). Terminal transitions stay in `lifecycle/transition.ts`
 * (kernel chokepoint); this module is the equivalent chokepoint for the
 * non-terminal pause axis so every pause/resume — operator REST, the
 * missing-skill guard, the stage-stall guard, the skill-registered
 * auto-resume — emits the SAME side effects:
 *
 *  - `pipelineRunStatusChanged` hook (Sentry breadcrumb + memory observer)
 *  - `pipeline_run.status_changed` WS broadcast to the project room
 *
 * Historically the operator path broadcast WS without the hook and the
 * guard paths emitted the hook without WS; consumers could not rely on
 * either signal. Both now always fire.
 *
 * `pauseReason` metadata contract: writers that pause with a machine
 * reason (`missing_skill:<stage>`, `stage_stalled:<stage>`) pass it via
 * `pauseReason`; resume ALWAYS clears the key. Leaving a stale reason
 * behind let a later `skillRegistered` auto-resume match (and resume) a
 * run an operator had re-paused for an unrelated cause.
 */

import { type SQL, and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { type HooksBus, hooks } from './hooks.js';

export type PipelineRunRow = typeof pipelineRuns.$inferSelect;

async function emitRunPauseTransition(
  run: PipelineRunRow,
  fromStatus: 'running' | 'paused',
  toStatus: 'paused' | 'running',
  bus: HooksBus,
): Promise<void> {
  await bus.emit('pipelineRunStatusChanged', {
    runId: run.id,
    projectId: run.projectId,
    issueId: run.issueId,
    kind: run.kind,
    fromStatus,
    toStatus,
    currentStep: run.currentStep,
  });
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

/**
 * CAS `running → paused`. Returns the updated row, or null when the run was
 * not `running` (already paused / terminal / missing) — callers disambiguate
 * with their own follow-up select when they need to.
 */
export async function pauseRun(args: {
  runId: string;
  /** Machine pause reason merged into `metadata.pauseReason`; omit for
   *  operator pauses (matchers must not auto-resume those). */
  pauseReason?: string | undefined;
  bus?: HooksBus | undefined;
}): Promise<PipelineRunRow | null> {
  const [row] = await db
    .update(pipelineRuns)
    .set({
      status: 'paused',
      updatedAt: new Date(),
      // COALESCE + merge so we never clobber sibling metadata keys.
      ...(args.pauseReason
        ? {
            metadata: sql`COALESCE(${pipelineRuns.metadata}, '{}'::jsonb) || jsonb_build_object('pauseReason', ${args.pauseReason}::text)`,
          }
        : {}),
    })
    .where(and(eq(pipelineRuns.id, args.runId), eq(pipelineRuns.status, 'running')))
    .returning();
  if (!row) return null;
  await emitRunPauseTransition(row, 'running', 'paused', args.bus ?? hooks);
  return row;
}

/**
 * CAS `paused → running` for every row matching `where`, clearing
 * `metadata.pauseReason`. Returns the resumed rows (empty when nothing
 * matched).
 */
export async function resumeRunsWhere(
  where: SQL | undefined,
  opts: { bus?: HooksBus | undefined } = {},
): Promise<PipelineRunRow[]> {
  const rows = await db
    .update(pipelineRuns)
    .set({
      status: 'running',
      updatedAt: new Date(),
      metadata: sql`COALESCE(${pipelineRuns.metadata}, '{}'::jsonb) - 'pauseReason'`,
    })
    .where(and(eq(pipelineRuns.status, 'paused'), where))
    .returning();
  for (const row of rows) {
    await emitRunPauseTransition(row, 'paused', 'running', opts.bus ?? hooks);
  }
  return rows;
}

/** CAS `paused → running` for one run. Null when the run was not paused. */
export async function resumeRun(args: {
  runId: string;
  bus?: HooksBus | undefined;
}): Promise<PipelineRunRow | null> {
  const rows = await resumeRunsWhere(eq(pipelineRuns.id, args.runId), { bus: args.bus });
  return rows[0] ?? null;
}
