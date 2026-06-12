/**
 * ISS-447 (ISS-442 C1) — the SINGLE writer of terminal status across the three
 * kernel tables (`jobs`, `agent_sessions`, `pipeline_runs`).
 *
 * Invariant I2: a terminal flip can ONLY happen through `applyKernelTransition`.
 * Because the function ALWAYS writes a `kernel_transitions` audit row in the
 * same executor as the status UPDATE, a new code path physically cannot land a
 * terminal status without leaving an audit trail. The `lifecycle.transition`
 * guard test (transition-guard.test.ts) fails the build if any file outside
 * this module does `.update(jobs|agentSessions|pipelineRuns).set({ status:
 * <terminal> })`, so the chokepoint cannot silently drift.
 *
 * The function is deliberately a thin PRIMITIVE: it performs the guarded CAS
 * write (caller supplies the `where` predicate, which MUST include the status
 * guard) plus the audit row, and returns the updated rows. All downstream
 * side-effects (cross-table cascade fan-out, WS broadcasts, hooks, dispatch
 * re-tick) stay in the callers exactly as before — so behaviour is preserved
 * and only the WRITE + AUDIT are centralised. Pass a transaction handle when
 * the flip must be atomic with a cascade or a sibling write (cancel audit,
 * run-close cascade); pass `db` for a standalone single-statement flip.
 *
 * `reason='pipeline_completed'` is the cascade's SUCCESS sentinel (a terminal
 * pipeline step set its issue terminal as its last action while its own
 * job/session was still active). `resolvePipelineCompletedTarget` maps that
 * sentinel to the success terminal on the JOB axis (`done`, mirroring the
 * ISS-352 session branch → `completed`) so a succeeded step is never recorded
 * as `cancelled`/`failed` (ISS-444 amendment 2).
 */

import type { SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  type AgentSessionStatus,
  type JobStatus,
  type PipelineRunStatus,
  agentSessions,
  jobs,
  kernelTransitions,
  pipelineRuns,
} from '../db/schema.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either a live transaction handle or the root `db`. The UPDATE + audit INSERT
 *  run on whichever is passed; pass a `tx` when atomicity with a cascade or a
 *  sibling write is required. */
export type KernelExecutor = Tx | Db;

export type KernelEntity = 'job' | 'session' | 'run';
export type KernelActorType = 'user' | 'system' | 'runner' | 'sweeper';
export interface KernelActor {
  type: KernelActorType;
  /** Bare uuid (no FK). NULL for system/sweeper actors with no principal. */
  id?: string | null;
}

type JobRow = typeof jobs.$inferSelect;
type SessionRow = typeof agentSessions.$inferSelect;
type RunRow = typeof pipelineRuns.$inferSelect;

interface BaseArgs {
  /** CAS predicate — MUST include the prior-status guard so concurrent writers
   *  cannot double-flip. Typed `SQL | undefined` to accept `and(...)` directly
   *  (drizzle's `and` is `SQL | undefined`); a bare `undefined` would match
   *  every row, so callers always pass a real predicate. */
  where: SQL | undefined;
  /** Declared prior status, recorded as `from_status` on the audit row. For a
   *  bulk flip spanning several prior statuses, pass the dominant/guarded one. */
  fromStatus?: string | null;
  /** Free-text cause (CascadeReason / failureReason / lifecycle marker). */
  reason?: string | null;
  actor: KernelActor;
  /** Which subsystem performed the flip (lifecycle | cascade | cancel | sweeper
   *  | dispatcher | runs | runs-control | schedule | session-cancel | stale). */
  source: string;
}

export interface JobTransitionArgs extends BaseArgs {
  entity: 'job';
  to: Extract<JobStatus, 'done' | 'failed' | 'cancelled'>;
  /** Extra column writes applied alongside `status` (exitCode, error,
   *  finishedAt, failureKind, …). */
  set?: Partial<Omit<JobRow, 'id' | 'status'>>;
}
export interface SessionTransitionArgs extends BaseArgs {
  entity: 'session';
  to: Extract<
    AgentSessionStatus,
    'completed' | 'failed' | 'completed_via_recovery' | 'cancelled_stale'
  >;
  set?: Partial<Omit<SessionRow, 'id' | 'status'>>;
}
export interface RunTransitionArgs extends BaseArgs {
  entity: 'run';
  to: Extract<PipelineRunStatus, 'completed' | 'failed' | 'cancelled'>;
  set?: Partial<Omit<RunRow, 'id' | 'status'>>;
}

/**
 * Map the `pipeline_completed` success sentinel to the success terminal status
 * for an entity; every other cascade reason keeps the caller's terminal. The
 * JOB axis resolves to `done` (ISS-444 amendment 2) and the SESSION axis to
 * `completed` (ISS-352), so a step that finished its work is never recorded as
 * cancelled/failed just because the run closed around its still-active row.
 */
export function resolvePipelineCompletedTarget<
  E extends KernelEntity,
  T extends string,
>(entity: E, reason: string | null | undefined, fallback: T): T | 'done' | 'completed' {
  if (reason !== 'pipeline_completed') return fallback;
  if (entity === 'job') return 'done';
  if (entity === 'session') return 'completed';
  return fallback;
}

/**
 * The single terminal-status writer. Performs the guarded CAS UPDATE, then
 * writes one `kernel_transitions` audit row per flipped entity. Returns the
 * updated rows (empty array when the CAS matched nothing — i.e. another writer
 * already owns the terminal state, or the guard excluded the row).
 */
export async function applyKernelTransition(
  exec: KernelExecutor,
  args: JobTransitionArgs,
): Promise<JobRow[]>;
export async function applyKernelTransition(
  exec: KernelExecutor,
  args: SessionTransitionArgs,
): Promise<SessionRow[]>;
export async function applyKernelTransition(
  exec: KernelExecutor,
  args: RunTransitionArgs,
): Promise<RunRow[]>;
export async function applyKernelTransition(
  exec: KernelExecutor,
  args: JobTransitionArgs | SessionTransitionArgs | RunTransitionArgs,
): Promise<JobRow[] | SessionRow[] | RunRow[]> {
  // drizzle's `.returning()` always yields an array; `?? []` only guards the
  // (test-double) case where a mock omits it, mirroring the prior call sites'
  // `updated ?? []` tolerance so a missing return can't crash the chokepoint.
  let updated: Array<{ id: string }>;
  if (args.entity === 'job') {
    updated =
      (await exec
        .update(jobs)
        .set({ ...(args.set ?? {}), status: args.to })
        .where(args.where)
        .returning()) ?? [];
  } else if (args.entity === 'session') {
    updated =
      (await exec
        .update(agentSessions)
        .set({ ...(args.set ?? {}), status: args.to })
        .where(args.where)
        .returning()) ?? [];
  } else {
    updated =
      (await exec
        .update(pipelineRuns)
        .set({ ...(args.set ?? {}), status: args.to })
        .where(args.where)
        .returning()) ?? [];
  }

  if (updated.length > 0) {
    await exec.insert(kernelTransitions).values(
      updated.map((row) => ({
        entity: args.entity,
        entityId: row.id,
        fromStatus: args.fromStatus ?? null,
        toStatus: args.to,
        reason: args.reason ?? null,
        actorType: args.actor.type,
        actorId: args.actor.id ?? null,
        source: args.source,
      })),
    );
  }

  return updated as JobRow[] | SessionRow[] | RunRow[];
}
