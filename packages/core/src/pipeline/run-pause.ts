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

import { and, eq, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { logger } from '../logger.js';
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
 * Every machine pause-reason kind that still has code able to clear it.
 *
 * `pauseReason` is written as `<kind>:<detail>`. {@link resumeOrphanedPauses}
 * frees any run whose kind is absent here.
 */
// cm:guard a kind in this list is a PROMISE that something resumes it — add one only together with its resume path, and DELETE it in the same commit as the mechanism it belongs to. RFC 0002 removed the reopen cap and left `reopen_cap:*` runs frozen with no owner: measured 2026-08-14, forge-dev ISS-576 and ISS-652 had been paused since 2026-08-11, their queued triage jobs invisible to the picker (which requires `r.status='running'`), so clicking "open" on the issue did nothing at all and no alarm anywhere fired.
export const LIVE_PAUSE_REASON_KINDS = ['missing_skill', 'stage_stalled'] as const;

export type PauseReasonKind = (typeof LIVE_PAUSE_REASON_KINDS)[number];

/** The only way to spell a machine pause reason — the kind must be registered. */
export function pauseReasonFor(kind: PauseReasonKind, detail: string): string {
  return `${kind}:${detail}`;
}

/** True when `reason` names a kind that still exists in this build. */
export function isLivePauseReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const kind = reason.split(':', 1)[0] ?? '';
  return (LIVE_PAUSE_REASON_KINDS as readonly string[]).includes(kind);
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
// cm:guard match on the kind's ABSENCE from LIVE_PAUSE_REASON_KINDS, never on a hardcoded list of retired kinds — a retired-kinds list has to be edited by whoever deletes a pauser, which is exactly the step that got skipped and left `reopen_cap:*` runs frozen. Absence needs no second edit.
// cm:guard `pauseReason IS NULL` must stay excluded — that is the operator pause, and auto-resuming it overrides a human decision with a sweep
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
    // cm:guard re-check for absence HERE, not only in the WHERE above — an operator pause has no reason, and leaning on the SQL predicate alone means a future edit to that query starts overriding human pauses with a sweep
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
