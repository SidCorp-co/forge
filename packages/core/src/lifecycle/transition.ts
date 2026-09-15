/**
 * ISS-447 (ISS-442 C1) — the SINGLE writer of terminal status across the three
 * kernel tables (`jobs`, `agent_sessions`, `pipeline_runs`).
 *
 * A thin PRIMITIVE by design: the guarded CAS write plus the audit row, and
 * nothing else. Every downstream side-effect (cascade fan-out, WS broadcast,
 * hooks, dispatch re-tick) stays in the caller.
 */
// cm:guard invariant I2 — the audit row is written in the same TRANSACTION as the status UPDATE, which is what makes a terminal status physically unable to land without a trail. A root-`db` executor is autocommit, so this module opens a transaction itself rather than letting the two statements commit separately; before ISS-884 they did, and a crash between them left an unaudited terminal flip written BY the audited path. `transition-guard.test.ts` scans the tree for `.update(jobs|agentSessions|pipelineRuns).set({ status: <terminal literal> })` outside this module and fails the build on one.
// cm:guard the guard test reads a status LITERAL, so a caller writing a VARIABLE status is invisible to it — `PATCH /api/agent-sessions/:id` is exactly that and is a real second terminal writer on the session axis. Anything hung on this chokepoint for sessions (the ISS-675 escalation bridge, the ISS-927 token revoke) needs a second half in `agent-sessions/routes.ts`, and no gate will tell you if you forget. The `forge.kernel_txn` half of that is now gated: `kernel-marker-guard.test.ts` reads the SHAPE of the `.set()` argument rather than its status literal, so the PATCH is caught there as a marker obligation even though it is invisible here.
// cm:guard the caller supplies `where` and it MUST carry the prior-status guard — the CAS is the only thing stopping two writers double-flipping, and a predicate without it matches every row.
// cm:guard pass a `tx` when the flip must be atomic with a cascade or a sibling write (cancel audit, run-close cascade); `db` is for a standalone flip. Either way this module opens a transaction of its own — a real one on `db`, a savepoint on a `tx` — so the executor decides what the flip is atomic WITH, never whether it is atomic at all. Passing `db` while inside a transaction that later rolls back still leaves the audit row behind describing a status nothing holds.
// cm:why `reason='pipeline_completed'` is the cascade's SUCCESS sentinel — a terminal pipeline step set its issue terminal while its own job/session was still active — so `resolvePipelineCompletedTarget` maps it to `done`/`completed` and a succeeded step is never recorded as `cancelled`/`failed` (ISS-444 amendment 2, ISS-352).

import { eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { type KernelExecutor, stampKernelTxn } from '../db/kernel-marker.js';
import {
  agentSessions,
  type JobStatus,
  jobs,
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

export type KernelEntity = 'job' | 'session' | 'run';
export type KernelActorType = 'user' | 'system' | 'runner' | 'sweeper';

// cm:guard `agency` is required on a `user` actor and ABSENT on every other kind, and that asymmetry is the point. `system`, `sweeper` and `runner` are machines by construction — there is no honest `human` answer for them and no call site should be able to write one. `user` is the only type where both answers are possible, because a job or session token transitions under its creator: `actor_type` says the write is that person's and is true, while `actor_agency` says a machine typed it and is also true. Making the field required there is what stops a new call site recording the column's `'human'` DEFAULT, which reads as plausible and which nobody reports.
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

// cm:why ISS-1014 — `returning` on each of the three shapes below names which columns a flip hands back. `.returning()` with no projection is `RETURNING *`, and on `agent_sessions` that is the `messages` transcript: 233 KB on average and 35 MB at the largest, pulled for every row a sweep flips (`closeIdleChatSessions` takes up to 200 a tick) so the caller can read four scalar columns off it. `id` is added to every projection, because the audit row below is written from it.
// cm:guard on a SESSION the projection ALWAYS carries `metadata` too, and that is not a convenience: `fireEscalationBridge` / `fireAgentChatBridge` are gated on `metadata.escalation` / `metadata.agentChat`, and the heartbeat hop in `jobs/loop-monitor.ts` deliberately sweeps exactly those sessions. A projection without `metadata` would read every marked row as unmarked and drop the escalation and agent-chat replies this chokepoint owes — silently, with the room left waiting.
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
  /** Columns to hand back; omit for the whole row. `metadata` is added to whatever
   *  is asked for, because the completion bridges below are gated on it. */
  returning?: readonly K[];
}
export interface RunTransitionArgs<K extends keyof RunRow = keyof RunRow> extends BaseArgs {
  entity: 'run';
  to: Extract<PipelineRunStatus, 'completed' | 'failed' | 'cancelled'>;
  set?: Partial<Omit<RunRow, 'id' | 'status'>>;
  /** Columns to hand back; omit for the whole row. See the guard above the shapes. */
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

/**
 * Map the `pipeline_completed` success sentinel to the success terminal status
 * for an entity; every other cascade reason keeps the caller's terminal. The
 * JOB axis resolves to `done` (ISS-444 amendment 2) and the SESSION axis to
 * `completed` (ISS-352), so a step that finished its work is never recorded as
 * cancelled/failed just because the run closed around its still-active row.
 */
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

/**
 * The single terminal-status writer. Performs the guarded CAS UPDATE, then
 * writes one `kernel_transitions` audit row per flipped entity. Returns the
 * updated rows (empty array when the CAS matched nothing — i.e. another writer
 * already owns the terminal state, or the guard excluded the row).
 *
 * The post-commit bridges fire OUTSIDE the write, because a token revoke or a
 * chat delivery for a transition that then rolls back is a side-effect with no
 * cause.
 */
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
    // cm:why ISS-675 — the bridges hang HERE rather than on their callers because this chokepoint catches every terminal session write except the runner's own happy-path `PATCH /:id`, and the callers (sweeper, cascade, cancel, dispatch-failure, …) are too many to wire individually without one drifting and hanging an escalation silent. Gated on a metadata marker, so it is a no-op for the overwhelming majority of session transitions.
    if (args.entity === 'session') {
      await fireSessionBridges(exec, updated, args.returning === undefined);
    }
  }

  return updated;
}

/**
 * Fire the two completion bridges for the sessions this flip touched.
 *
 * The bridges need the WHOLE row — `messages`, `status`, `failureReason` — but
 * only for a session whose `metadata` carries their marker, which is a handful
 * of rows against a sweep's hundreds. So a narrow flip hydrates the marked ones
 * and leaves the rest alone; a whole-row flip already has what they need.
 */
// cm:guard the hydration reads through `exec`, never the root `db`: a caller that passed its own `tx` has not committed the flip yet, and a second connection would read the PRE-flip row — the bridges would then screen a session that still looks active and post the wrong answer, or none.
async function fireSessionBridges(
  exec: KernelExecutor,
  rows: Array<Record<string, unknown> & { id: string }>,
  whole: boolean,
): Promise<void> {
  for (const row of rows) {
    const metadata = row.metadata as { escalation?: unknown; agentChat?: unknown } | null;
    if (!metadata?.escalation && !metadata?.agentChat) continue;
    let full = row as unknown as SessionRow;
    if (!whole) {
      const [hydrated] = await exec
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, row.id))
        .limit(1);
      if (!hydrated) {
        logger.error(
          { sessionId: row.id },
          'lifecycle.transition: a bridge-marked session could not be re-read after its flip; its completion reply was not delivered',
        );
        continue;
      }
      full = hydrated;
    }
    fireEscalationBridge(full);
    fireAgentChatBridge(full);
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
      // cm:guard a name the table does not carry is REFUSED here rather than silently dropped from the projection: a caller that then reads the field would get `undefined` and read it as "the column is null", which is a state-never-lies violation wearing a typo (`VISION: state-never-lies`).
      throw new Error(
        `applyKernelTransition: returning names \`${key}\`, which is not a column of \`${entity}\``,
      );
    }
    projection[key] = column;
  }
  return projection;
}

/**
 * The CAS UPDATE, the audit row, and the marker that tells the database these
 * belong to one another. Always reached through `exec.transaction`, which opens
 * a real transaction on the root `db` and a SAVEPOINT on a caller's `tx`, so the
 * three statements are one atomic unit no matter which executor arrived.
 */
// cm:edge contract -> packages/core/src/db/kernel-marker.ts — `stampKernelTxn` is what keeps this flip out of the interventions metric; calling it AFTER the UPDATE, or not at all, charts every kernel flip this repo performs as manual SQL in the north-star.
async function writeTransition(
  exec: KernelExecutor,
  args: JobTransitionArgs | SessionTransitionArgs | RunTransitionArgs,
): Promise<Array<Record<string, unknown> & { id: string }>> {
  await stampKernelTxn(exec);
  const table =
    args.entity === 'job' ? jobs : args.entity === 'session' ? agentSessions : pipelineRuns;
  const projection = projectionFor(table, args.entity, args.returning);
  const write = exec
    .update(table as typeof jobs)
    .set({ ...(args.set ?? {}), status: args.to } as Partial<JobRow>)
    .where(args.where);
  // cm:why `?? []` guards a TEST DOUBLE, not drizzle — `.returning()` always yields an array in production. It mirrors the tolerance the prior call sites had so a mock that omits the return cannot crash the chokepoint.
  const updated = ((projection ? await write.returning(projection) : await write.returning()) ??
    []) as Array<Record<string, unknown> & { id: string }>;

  if (updated.length > 0) {
    await exec.insert(kernelTransitions).values(
      updated.map((row) => ({
        entity: args.entity,
        entityId: row.id,
        fromStatus: args.fromStatus ?? null,
        toStatus: args.to,
        reason: args.reason ?? null,
        actorType: args.actor.type,
        actorAgency: agencyOf(args.actor),
        actorId: args.actor.id ?? null,
        source: args.source,
      })),
    );
  }

  return updated;
}

function fireEscalationBridge(row: SessionRow): void {
  const metadata = row.metadata as { escalation?: unknown } | null;
  if (!metadata?.escalation) return;
  void import('../integrations/rocketchat/escalation-bridge.js')
    .then((mod) => mod.deliverEscalationReplyOnce(row))
    .catch((err) => {
      logger.error({ err, sessionId: row.id }, 'lifecycle.transition: escalation bridge failed');
    });
}

/**
 * ISS-727 — the `agent`-mode counterpart to {@link fireEscalationBridge}.
 * Same chokepoint, distinct metadata marker (`metadata.agentChat`), distinct
 * bridge module — see that function's JSDoc for why this chokepoint is the
 * only reliable catch-all for non-happy-path terminal writes.
 */
function fireAgentChatBridge(row: SessionRow): void {
  const metadata = row.metadata as { agentChat?: unknown } | null;
  if (!metadata?.agentChat) return;
  void import('../integrations/rocketchat/agent-chat-bridge.js')
    .then((mod) => mod.deliverAgentChatReplyOnce(row))
    .catch((err) => {
      logger.error({ err, sessionId: row.id }, 'lifecycle.transition: agent-chat bridge failed');
    });
}
