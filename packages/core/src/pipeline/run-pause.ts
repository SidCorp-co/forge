import { and, eq, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
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
 * Machine pause kinds a MACHINE clears: something in this build watches for the
 * condition and resumes the run without anyone being asked.
 */
export const MACHINE_RESUMED_PAUSE_KINDS: readonly string[] = [];

/**
 * Machine pause kinds only a PERSON clears.
 */
export const HUMAN_RESUMED_PAUSE_KINDS = ['stage_stalled'] as const;

/**
 * Every machine pause-reason kind that still has code able to clear it.
 *
 * `pauseReason` is written as `<kind>:<detail>`. {@link resumeOrphanedPauses}
 * frees any run whose kind is absent here.
 */
export const LIVE_PAUSE_REASON_KINDS = [
  ...MACHINE_RESUMED_PAUSE_KINDS,
  ...HUMAN_RESUMED_PAUSE_KINDS,
] as const;

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

export function pauseResumesItself(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const kind = reason.split(':', 1)[0] ?? '';
  return (MACHINE_RESUMED_PAUSE_KINDS as readonly string[]).includes(kind);
}

/** Who ends this pause. The one question a surface describing a pause has to
 *  answer, and the only thing its copy may branch on. */
export type PauseResumer = 'operator' | 'machine' | 'sweeper';

/** A `pauseReason` read apart, for a surface that has to name the pause. */
export interface PauseDescription {
  /** The kind half of `<kind>:<detail>`; null for an operator pause. */
  kind: string | null;
  /** The detail half — the stage, for `stage_stalled:<stage>`. */
  detail: string | null;
  resumer: PauseResumer;
}

/**
 * Read a `pauseReason` as the three things a banner needs: which kind holds the
 * run, what its detail names, and who ends it.
 */
export function describePause(reason: string | null | undefined): PauseDescription {
  if (!reason) return { kind: null, detail: null, resumer: 'operator' };
  const separator = reason.indexOf(':');
  const kind = separator === -1 ? reason : reason.slice(0, separator);
  const detail = separator === -1 ? null : reason.slice(separator + 1) || null;
  if (pauseResumesItself(reason)) return { kind, detail, resumer: 'machine' };
  return { kind, detail, resumer: isLivePauseReason(reason) ? 'operator' : 'sweeper' };
}

export async function pauseRun(args: {
  runId: string;
  /** Machine pause reason merged into `metadata.pauseReason`; omit for
   *  operator pauses (matchers must not auto-resume those). */
  pauseReason?: string | undefined;
  bus?: HooksBus | undefined;
}): Promise<PipelineRunRow | null> {
  const [row] = await withKernelMarker(db, async (tx) =>
    tx
      .update(pipelineRuns)
      .set({
        status: 'paused',
        updatedAt: new Date(),
        ...(args.pauseReason
          ? {
              metadata: sql`COALESCE(${pipelineRuns.metadata}, '{}'::jsonb) || jsonb_build_object('pauseReason', ${args.pauseReason}::text)`,
            }
          : {}),
      })
      .where(and(eq(pipelineRuns.id, args.runId), eq(pipelineRuns.status, 'running')))
      .returning(),
  );
  if (!row) return null;
  await emitRunPauseTransition(row, 'running', 'paused', args.bus ?? hooks);
  return row;
}

export async function resumeRunsWhere(
  where: SQL | undefined,
  opts: { bus?: HooksBus | undefined } = {},
): Promise<PipelineRunRow[]> {
  const rows = await withKernelMarker(db, async (tx) =>
    tx
      .update(pipelineRuns)
      .set({
        status: 'running',
        updatedAt: new Date(),
        metadata: sql`COALESCE(${pipelineRuns.metadata}, '{}'::jsonb) - 'pauseReason'`,
      })
      .where(and(eq(pipelineRuns.status, 'paused'), where))
      .returning(),
  );
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
