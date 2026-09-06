/**
 * ISS-447 (ISS-442 C1) — the SINGLE writer of terminal status across the three
 * kernel tables (`jobs`, `agent_sessions`, `pipeline_runs`).
 *
 * A thin PRIMITIVE by design: the guarded CAS write plus the audit row, and
 * nothing else. Every downstream side-effect (cascade fan-out, WS broadcast,
 * hooks, dispatch re-tick) stays in the caller.
 */
// cm:guard invariant I2 — the audit row is written in the SAME executor as the status UPDATE, which is what makes a terminal status physically unable to land without a trail. `transition-guard.test.ts` scans the tree for `.update(jobs|agentSessions|pipelineRuns).set({ status: <terminal literal> })` outside this module and fails the build on one.
// cm:guard the guard test reads a status LITERAL, so a caller writing a VARIABLE status is invisible to it — `PATCH /api/agent-sessions/:id` is exactly that and is a real second terminal writer on the session axis. Anything hung on this chokepoint for sessions (the ISS-675 escalation bridge, the ISS-927 token revoke) needs a second half in `agent-sessions/routes.ts`, and no gate will tell you if you forget.
// cm:guard the caller supplies `where` and it MUST carry the prior-status guard — the CAS is the only thing stopping two writers double-flipping, and a predicate without it matches every row.
// cm:guard pass a `tx` when the flip must be atomic with a cascade or a sibling write (cancel audit, run-close cascade); `db` is for a standalone single-statement flip. Passing `db` inside a transaction that later rolls back leaves the audit row behind describing a status nothing holds.
// cm:why `reason='pipeline_completed'` is the cascade's SUCCESS sentinel — a terminal pipeline step set its issue terminal while its own job/session was still active — so `resolvePipelineCompletedTarget` maps it to `done`/`completed` and a succeeded step is never recorded as `cancelled`/`failed` (ISS-444 amendment 2, ISS-352).

import type { SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
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

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either a live transaction handle or the root `db`. The UPDATE + audit INSERT
 *  run on whichever is passed; pass a `tx` when atomicity with a cascade or a
 *  sibling write is required. */
export type KernelExecutor = Tx | Db;

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

export interface JobTransitionArgs extends BaseArgs {
  entity: 'job';
  to: Extract<JobStatus, 'done' | 'failed' | 'cancelled'>;
  /** Extra column writes applied alongside `status` (exitCode, error,
   *  finishedAt, failureKind, …). */
  set?: Partial<Omit<JobRow, 'id' | 'status'>>;
}
export interface SessionTransitionArgs extends BaseArgs {
  entity: 'session';
  to: (typeof terminalAgentSessionStatuses)[number];
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
        actorAgency: agencyOf(args.actor),
        actorId: args.actor.id ?? null,
        source: args.source,
      })),
    );
    // ISS-675 — this chokepoint is the ONLY reliable place to catch every
    // terminal write to a session EXCEPT the runner's own happy-path PATCH
    // /:id (a direct db.update, wired separately in agent-sessions/routes.ts).
    // Callers of applyKernelTransition are too numerous and scattered (sweeper,
    // cascade, cancel, dispatch-failure, …) to wire individually without one
    // eventually drifting and hanging an escalation silent — see the ISS-675
    // plan's top risk. Narrowly gated on a metadata marker so it is a no-op for
    // the overwhelming majority of (non-escalation) session transitions.
    if (args.entity === 'session') {
      for (const row of updated as SessionRow[]) {
        fireEscalationBridge(row);
        fireAgentChatBridge(row);
        fireSessionTokenRevoke(row);
      }
    }
    // cm:guard the JOB revoke rides on THIS chokepoint and nowhere else, because this module is the only writer of a terminal job status — the `lifecycle.transition` guard test fails the build on a terminal `.update(jobs)` anywhere outside it. That is what makes the token's lifetime provably the job's: cancel, cascade, loop-monitor reap, park reap and the happy finish all land here, so no new terminal path can ship a token that outlives its job without first breaking a gate.
    if (args.entity === 'job') {
      for (const row of updated as JobRow[]) fireJobTokenRevoke(row);
    }
  }

  return updated as JobRow[] | SessionRow[] | RunRow[];
}

/**
 * Fire-and-forget, dynamically imported so this low-level kernel module never
 * statically drags in the RocketChat/knowledge dependency graph — mirrors the
 * existing lazy-import convention used to keep this kind of chokepoint
 * hermetic (e.g. `jobs/loop-monitor.ts`'s lazy `schedules/dispatch.js` load).
 * Errors are swallowed here (logged only): a bridge failure must never break
 * the kernel transition it rides on.
 */
function fireJobTokenRevoke(row: JobRow): void {
  void import('../jobs/job-token.js')
    .then((mod) => mod.revokeJobToken(row.id))
    .catch((err) => {
      logger.error({ err, jobId: row.id }, 'lifecycle.transition: job-token revoke failed');
    });
}

// cm:edge lockstep -> packages/core/src/agent-sessions/routes.ts — unlike the JOB revoke above, this chokepoint is NOT sufficient on its own. The runner's happy-path completion writes `agent_sessions.status` directly in `PATCH /:id`, so that handler fires the same revoke, and the pair must stay in step: deleting either one leaves a live write-scoped credential behind a whole class of finished sessions. The `lifecycle.transition` guard test cannot protect this the way it protects the job axis — it scans for a status LITERAL and that handler writes `patch.status`, a variable — so the only thing holding the pair together is this note and the test that plants a normal completion.
function fireSessionTokenRevoke(row: SessionRow): void {
  void import('../agent-sessions/session-token.js')
    .then((mod) => mod.revokeSessionToken(row.id))
    .catch((err) => {
      logger.error({ err, sessionId: row.id }, 'lifecycle.transition: session-token revoke failed');
    });
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
