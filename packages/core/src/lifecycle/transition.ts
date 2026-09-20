/**
 * ISS-447 (ISS-442 C1) — the SINGLE writer of terminal status across the three
 * kernel tables (`jobs`, `agent_sessions`, `pipeline_runs`).
 *
 * A thin PRIMITIVE by design: the guarded CAS write plus the audit row, and
 * nothing else. Every downstream side-effect (cascade fan-out, WS broadcast,
 * hooks, dispatch re-tick) stays in the caller.
 */

import { eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  fireTerminalSessionBridges,
  sessionCarriesBridgeMarker,
} from '../agent-sessions/terminal-effects.js';
import { type KernelExecutor, stampKernelTxn } from '../db/kernel-marker.js';
import {
  agentSessions,
  type JobStatus,
  jobs,
  type KernelTransitionEntity,
  kernelTransitions,
  type PipelineRunStatus,
  pipelineRuns,
  type terminalAgentSessionStatuses,
} from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { logger } from '../logger.js';

/** Re-exported so a caller that already imports the chokepoint keeps one import.
 *  The UPDATE + audit INSERT run on whichever executor is passed; pass a `tx`
 *  when atomicity with a cascade or a sibling write is required. */
export type { KernelExecutor };

/**
 * The entities this module's CAS write can drive. `issues` is audited too
 * (ISS-1107) but is NOT one of them: its writer carries a compare-and-set on
 * the prior status and columns no row type here has, so it writes its own
 * UPDATE and calls `recordKernelTransition` for the audit row. Anything that
 * reaches `applyKernelTransition` with `issue` is refused by name rather than
 * falling through to `pipeline_runs`.
 */
export type KernelEntity = 'job' | 'session' | 'run';
export type KernelActorType = 'user' | 'system' | 'runner' | 'sweeper';

export type KernelActor =
  | {
      type: 'user';
      /** Bare uuid (no FK). */
      id?: string | null;
      agency: ActorAgency;
    }
  | {
      type: Exclude<KernelActorType, 'user'>;
      /** Bare uuid (no FK). NULL for system/sweeper actors with no principal. */
      id?: string | null;
    };

/** The stored agency for an actor: a machine kind is `agent`, a user carries its own answer. */
function agencyOf(actor: KernelActor): ActorAgency {
  return actor.type === 'user' ? actor.agency : 'agent';
}

type JobRow = typeof jobs.$inferSelect;
type SessionRow = typeof agentSessions.$inferSelect;
type RunRow = typeof pipelineRuns.$inferSelect;

interface BaseArgs {
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

export interface JobTransitionArgs<K extends keyof JobRow = keyof JobRow> extends BaseArgs {
  entity: 'job';
  to: Extract<JobStatus, 'done' | 'failed' | 'cancelled'>;
  /** Extra column writes applied alongside `status` (exitCode, error,
   *  finishedAt, failureKind, …). */
  set?: Partial<Omit<JobRow, 'id' | 'status'>>;
  /** Columns to hand back; omit for the whole row. See the guard above the shapes. */
  returning?: readonly K[];
}
export interface SessionTransitionArgs<K extends keyof SessionRow = keyof SessionRow>
  extends BaseArgs {
  entity: 'session';
  to: (typeof terminalAgentSessionStatuses)[number];
  set?: Partial<Omit<SessionRow, 'id' | 'status'>>;
  returning?: readonly K[];
}
export interface RunTransitionArgs<K extends keyof RunRow = keyof RunRow> extends BaseArgs {
  entity: 'run';
  to: Extract<PipelineRunStatus, 'completed' | 'failed' | 'cancelled'>;
  set?: Partial<Omit<RunRow, 'id' | 'status'>>;
  returning?: readonly K[];
}

/**
 * What a bulk session sweep reads off each row it flips: the three ids the WS
 * broadcast needs, the run the wedge looks its issue up through, and the status
 * the row landed on.
 *
 * Shared so the five sweep call sites cannot drift apart into five projections.
 */
export const SWEEP_SESSION_COLUMNS = [
  'id',
  'projectId',
  'deviceId',
  'pipelineRunId',
  'status',
] as const;

export function resolvePipelineCompletedTarget<E extends KernelEntity, T extends string>(
  entity: E,
  reason: string | null | undefined,
  fallback: T,
): T | 'done' | 'completed' {
  if (reason !== 'pipeline_completed') return fallback;
  if (entity === 'job') return 'done';
  if (entity === 'session') return 'completed';
  return fallback;
}

export async function applyKernelTransition<K extends keyof JobRow = keyof JobRow>(
  exec: KernelExecutor,
  args: JobTransitionArgs<K>,
): Promise<Array<Pick<JobRow, K | 'id'>>>;
export async function applyKernelTransition<K extends keyof SessionRow = keyof SessionRow>(
  exec: KernelExecutor,
  args: SessionTransitionArgs<K>,
): Promise<Array<Pick<SessionRow, K | 'id' | 'metadata'>>>;
export async function applyKernelTransition<K extends keyof RunRow = keyof RunRow>(
  exec: KernelExecutor,
  args: RunTransitionArgs<K>,
): Promise<Array<Pick<RunRow, K | 'id'>>>;
export async function applyKernelTransition(
  exec: KernelExecutor,
  args: JobTransitionArgs | SessionTransitionArgs | RunTransitionArgs,
): Promise<unknown[]> {
  const updated = await exec.transaction((tx) => writeTransition(tx, args));

  if (updated.length > 0) {
    if (args.entity === 'session') {
      await fireSessionBridges(exec, updated, args.returning === undefined);
    }
  }

  return updated;
}

async function fireSessionBridges(
  exec: KernelExecutor,
  rows: Array<Record<string, unknown> & { id: string }>,
  whole: boolean,
): Promise<void> {
  for (const row of rows) {
    if (!sessionCarriesBridgeMarker(row.metadata)) continue;
    let full = row as unknown as SessionRow;
    if (!whole) {
      const hydrated = await hydrateSession(exec, row.id);
      if (!hydrated) continue;
      full = hydrated;
    }
    void fireTerminalSessionBridges(full);
  }
}

/**
 * The whole row behind one bridge-marked id, or `null` with the reason logged.
 */
async function hydrateSession(exec: KernelExecutor, sessionId: string): Promise<SessionRow | null> {
  try {
    const [row] = await exec
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    if (row) return row;
    logger.error(
      { sessionId },
      'lifecycle.transition: a bridge-marked session could not be re-read after its flip; its completion reply was not delivered',
    );
    return null;
  } catch (err) {
    logger.error(
      { err, sessionId },
      'lifecycle.transition: re-reading a bridge-marked session after its flip failed; its completion reply was not delivered',
    );
    return null;
  }
}

/**
 * The drizzle `.returning()` argument for a named projection, or `undefined`
 * when the caller asked for the whole row.
 *
 * The guard above the three argument shapes says why `id` — and, on a session,
 * `metadata` — are in every projection whether or not the caller named them.
 */
function projectionFor(
  table: typeof jobs | typeof agentSessions | typeof pipelineRuns,
  entity: KernelEntity,
  keys: readonly string[] | undefined,
): Record<string, PgColumn> | undefined {
  if (!keys) return undefined;
  const columns = table as unknown as Record<string, PgColumn>;
  const wanted = new Set<string>([...keys, 'id', ...(entity === 'session' ? ['metadata'] : [])]);
  const projection: Record<string, PgColumn> = {};
  for (const key of wanted) {
    const column = columns[key];
    if (!column) {
      throw new Error(
        `applyKernelTransition: returning names \`${key}\`, which is not a column of \`${entity}\``,
      );
    }
    projection[key] = column;
  }
  return projection;
}

/** What one audit row says, whoever wrote the UPDATE it belongs to. */
export interface KernelTransitionRecord {
  entity: KernelTransitionEntity;
  entityId: string;
  fromStatus?: string | null;
  toStatus: string;
  reason?: string | null;
  actor: KernelActor;
  source: string;
}

/**
 * THE writer of `kernel_transitions`. `writeTransition` calls it for the three
 * tables it owns; `issues/apply-transition.ts` calls it for the fourth, whose
 * UPDATE it writes itself. Run it on the same executor as that UPDATE — a row
 * that can be missing when the update succeeded reads as "nobody did this".
 */
export async function recordKernelTransition(
  exec: KernelExecutor,
  rows: readonly KernelTransitionRecord[],
): Promise<void> {
  if (rows.length === 0) return;
  await exec.insert(kernelTransitions).values(
    rows.map((row) => ({
      entity: row.entity,
      entityId: row.entityId,
      fromStatus: row.fromStatus ?? null,
      toStatus: row.toStatus,
      reason: row.reason ?? null,
      actorType: row.actor.type,
      actorAgency: agencyOf(row.actor),
      actorId: row.actor.id ?? null,
      source: row.source,
    })),
  );
}

/**
 * The table each entity this chokepoint drives writes to. An entity with no
 * entry is refused where the gap is, rather than defaulting to the last arm of
 * a ternary chain — which is what `issue` would have done.
 */
type KernelTable = typeof jobs | typeof agentSessions | typeof pipelineRuns;

/**
 * The table this chokepoint writes for an entity. Resolved here rather than by
 * a ternary chain, because a chain has a last arm: an entity with no table of
 * its own would have landed silently on `pipeline_runs`, which is how `issue`
 * would have been absorbed. It is refused by name instead.
 *
 * Read lazily, never captured at module load — the tables are drizzle objects
 * and a module-level map of them is evaluated before a caller's partial mock
 * of the schema exists.
 */
function tableForEntity(entity: KernelEntity): KernelTable {
  switch (entity) {
    case 'job':
      return jobs;
    case 'session':
      return agentSessions;
    case 'run':
      return pipelineRuns;
    default:
      throw new Error(
        `applyKernelTransition drives job, session and run, and has no table for \`${entity}\`. An \`issue\` status write goes through \`issues/apply-transition.ts:transitionIssueStatus\`, which carries the compare-and-set this chokepoint cannot express and calls \`recordKernelTransition\` for its own audit row.`,
      );
  }
}

async function writeTransition(
  exec: KernelExecutor,
  args: JobTransitionArgs | SessionTransitionArgs | RunTransitionArgs,
): Promise<Array<Record<string, unknown> & { id: string }>> {
  const table = tableForEntity(args.entity);
  await stampKernelTxn(exec);
  const projection = projectionFor(table, args.entity, args.returning);
  const write = exec
    .update(table as typeof jobs)
    .set({ ...(args.set ?? {}), status: args.to } as Partial<JobRow>)
    .where(args.where);
  const updated = ((projection ? await write.returning(projection) : await write.returning()) ??
    []) as Array<Record<string, unknown> & { id: string }>;

  await recordKernelTransition(
    exec,
    updated.map((row) => ({
      entity: args.entity,
      entityId: row.id,
      fromStatus: args.fromStatus ?? null,
      toStatus: args.to,
      reason: args.reason ?? null,
      actor: args.actor,
      source: args.source,
    })),
  );

  return updated;
}
