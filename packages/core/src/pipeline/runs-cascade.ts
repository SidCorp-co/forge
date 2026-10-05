import {
  JOB_MACHINE,
  LIVE_JOB_STATUSES,
  OCCUPYING_JOB_STATUSES,
} from '@forge/contracts/job-machine';
import { RUN_MACHINE } from '@forge/contracts/run-machine';
import { LIVE_SESSION_STATUSES } from '@forge/contracts/session-machine';
import { and, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentSessions, jobs, pipelineRuns } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { RefusalError } from '../lib/refusal.js';
import {
  type KernelActor,
  type TransitionArgs,
  type TransitionResult,
  transition,
} from '../lifecycle/index.js';
import { requestJobKill, transitionSessions } from './ports.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type JobRow = typeof jobs.$inferSelect;
type RunRow = typeof pipelineRuns.$inferSelect;

type CascadeReason = 'pipeline_cancelled' | 'pipeline_completed' | 'pipeline_failed';

/**
 * Why a run failed, in the words of the writer that failed it. Required on every failed close:
 * the run keeps it as `metadata.failure`, and each job and session the cascade stops carries it,
 * so no run goes `failed` with nothing on record to say why.
 */
export interface RunFailureCause {
  /** A stable, machine-readable name for the condition, e.g. `deploy_failed`. */
  code: string;
  /** What was read and where, in a sentence a person can act on. */
  detail: string;
}

interface CascadeResult {
  cancelledJobIds: string[];
  abortedSessionIds: string[];
  deviceBySession: Map<string, string>;
  /** ISS-785 — the terminal-flipped job rows that have a device to kill on.
   *  Pass to `requestKillsForCascade` AFTER the transaction commits (same
   *  "never publish/act on a rolled-back write" contract the old
   *  `agent:abort` fan-out had). */
  killableJobs: JobRow[];
}

/** A move the close cannot take is the close's failure: the transaction rolls back with it. */
function settled<R>(result: TransitionResult<R>): R[] {
  const [lead] = result.refusals;
  if (lead) throw new RefusalError(result.refusals, lead.code);
  return result.rows;
}

/**
 * Lock the runs a close is about to end in this transaction, and every run their cascade and
 * session descent can reach, before the first write that decides the close (ISS-219). The locks
 * are taken one at a time in {@link runTreeInLockOrder}'s order, which every close shares.
 */
export async function lockRunForClose(
  tx: Tx | Db,
  runIds: string | readonly string[],
): Promise<void> {
  const roots = (typeof runIds === 'string' ? [runIds] : [...runIds]).filter(Boolean);
  if (roots.length === 0) return;
  for (const id of await runTreeInLockOrder(tx, roots)) {
    await tx
      .select({ id: pipelineRuns.id })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, id))
      .for('update');
  }
}

/** The same bound the descent walks to (`agent-sessions/session-descent.ts:MAX_DEPTH`). */
const TREE_DEPTH = 8;

/**
 * Every run a close of `roots` can reach: the roots, and each run whose sessions are owned,
 * transitively, by a session on one of them or linked from one of their jobs, which is the set
 * the cascade and the session descent write under. Ordered by each run's depth in the whole
 * ownership forest (the ancestors above it, not its distance from these roots), then by id, so
 * two closes that share a run always take their locks in one order and the descent deadlock
 * cannot form: a parent run is always locked before its child.
 */
async function runTreeInLockOrder(tx: Tx | Db, roots: string[]): Promise<string[]> {
  const ids = sql.join(
    roots.map((r) => sql`${r}::uuid`),
    sql`, `,
  );
  const rows = (await tx.execute(sql`
    WITH RECURSIVE down(run_id, session_id, n) AS (
      SELECT s.pipeline_run_id, s.id, 0
        FROM agent_sessions s
       WHERE s.pipeline_run_id IN (${ids})
          OR s.id IN (SELECT j.agent_session_id FROM jobs j WHERE j.pipeline_run_id IN (${ids}))
      UNION
      SELECT c.pipeline_run_id, c.id, d.n + 1
        FROM agent_sessions c
        JOIN down d ON c.parent_session_id = d.session_id
       WHERE d.n < ${TREE_DEPTH}
    ),
    tree(run_id) AS (
      SELECT run_id FROM down WHERE run_id IS NOT NULL
      UNION
      SELECT r FROM unnest(ARRAY[${ids}]) AS r
    ),
    up(run_id, ancestor, n) AS (
      SELECT s.pipeline_run_id, s.parent_session_id, 0
        FROM agent_sessions s
        JOIN tree t ON s.pipeline_run_id = t.run_id
       WHERE s.parent_session_id IS NOT NULL
      UNION
      SELECT u.run_id, p.parent_session_id, u.n + 1
        FROM up u
        JOIN agent_sessions p ON p.id = u.ancestor
       WHERE p.parent_session_id IS NOT NULL AND u.n < ${TREE_DEPTH}
    )
    SELECT t.run_id::text AS run_id, COALESCE(MAX(u.n) + 1, 0) AS depth
      FROM tree t
      LEFT JOIN up u ON u.run_id = t.run_id
     GROUP BY t.run_id
     ORDER BY depth, t.run_id
  `)) as unknown as Array<{ run_id: string }>;
  return rows.map((r) => String(r.run_id));
}

export interface RunClose {
  to: 'completed' | 'failed' | 'cancelled';
  /** Which runs, and the statuses each may close from. */
  where: SQL | undefined;
  /** Columns written beside `finishedAt` and `updatedAt`. */
  set?: TransitionArgs<'run', never>['set'];
  reason: CascadeReason;
  actor: KernelActor;
  source: string;
  /** Required when `to` is `failed`, and refused otherwise. */
  cause?: RunFailureCause | undefined;
}

/** The record a failed close leaves on its run, merged over whatever `set.metadata` writes. */
function failureMetadata(close: RunClose, at: Date): TransitionArgs<'run', never>['set'] {
  if (close.to !== 'failed') {
    if (close.cause) {
      throw new Error(
        `closeRunsInTx: ${close.source} named a failure cause (${close.cause.code}) on a close to \`${close.to}\`; only a failed close carries one`,
      );
    }
    return {};
  }
  if (!close.cause) {
    throw new Error(
      `closeRunsInTx: ${close.source} closes runs \`failed\` without naming why; pass \`cause\` so the run records what failed it`,
    );
  }
  const failure = JSON.stringify({ failure: { ...close.cause, source: close.source, at } });
  const base = close.set?.metadata ?? sql`coalesce(${pipelineRuns.metadata}, '{}'::jsonb)`;
  return { metadata: sql`${base} || ${failure}::jsonb` };
}

/**
 * The one way a run reaches a terminal status (ISS-219). The runs are locked `FOR UPDATE` before
 * the move, so a writer checking that a run takes work waits for this close and then reads it
 * closed; the move and the cascade over every child it leaves are one transaction with it.
 * Answers the runs it closed with each one's cascade, whose kills are the caller's to request once
 * the transaction commits.
 */
export async function closeRunsInTx(
  tx: Tx | Db,
  close: RunClose,
): Promise<{ rows: RunRow[]; cascades: Array<{ runId: string; result: CascadeResult }> }> {
  // An absent predicate would lock and close every open run.
  if (!close.where) throw new Error(`closeRunsInTx: ${close.source} named no runs to close`);
  const locked = await tx.select({ id: pipelineRuns.id }).from(pipelineRuns).where(close.where);
  if (locked.length === 0) return { rows: [], cascades: [] };
  await lockRunForClose(
    tx,
    locked.map((r) => r.id),
  );
  const now = new Date();
  const failure = failureMetadata(close, now);
  const rows = settled(
    await transition(tx, RUN_MACHINE, {
      to: close.to,
      set: { finishedAt: now, updatedAt: now, ...close.set, ...failure },
      where: and(
        inArray(
          pipelineRuns.id,
          locked.map((r) => r.id),
        ),
        close.where,
      ),
      reason: close.reason,
      actor: close.actor,
      source: close.source,
    }),
  );
  const cascades: Array<{ runId: string; result: CascadeResult }> = [];
  for (const row of rows) {
    cascades.push({
      runId: row.id,
      result: await cascadeCancelChildJobs(tx, row.id, close.reason, close.cause),
    });
  }
  return { rows, cascades };
}

// cm:flow release/reap after:close — closing the run reaps its child jobs, and on a `pipeline_completed` close the release job that is still running flips to done, NOT cancelled; that sentinel is why a successful release does not look like a cancelled one
async function cascadeCancelChildJobs(
  tx: Tx | Db,
  runId: string,
  reason: CascadeReason,
  cause: RunFailureCause | undefined,
): Promise<CascadeResult> {
  const now = new Date();
  const runFailure = cause ? JSON.stringify({ runFailure: cause }) : null;

  // ISS-444 amendment 2 — the JOB axis mirrors the ISS-352 session branch
  // below: a run closing as `pipeline_completed` is the cascade's SUCCESS
  // sentinel, so the step's own still-active job resolves to `done` (NOT
  // cancelled). Genuine cancel/fail closes still cancel their active children.
  const completedSuccess = reason === 'pipeline_completed';
  const doneJobs = completedSuccess
    ? settled(
        await transition(tx, JOB_MACHINE, {
          to: 'done',
          set: {
            finishedAt: now,
            exitCode: 0,
            error: null,
            failureKind: null,
            failureReason: null,
          },
          where: and(
            eq(jobs.pipelineRunId, runId),
            inArray(jobs.status, [...OCCUPYING_JOB_STATUSES]),
          ),
          reason,
          actor: { type: 'system' },
          source: 'cascade',
        }),
      )
    : [];
  // A job the success close cannot finish never ran (queued, or held), so it is cancelled with the
  // rest: no close leaves a live child behind it.
  const stoppedJobs = settled(
    await transition(tx, JOB_MACHINE, {
      to: 'cancelled',
      set: {
        finishedAt: now,
        cancellationRequested: true,
        failureKind: 'infra',
        failureReason: reason,
        ...(runFailure
          ? { failureMeta: sql`coalesce(${jobs.failureMeta}, '{}'::jsonb) || ${runFailure}::jsonb` }
          : {}),
      },
      where: and(eq(jobs.pipelineRunId, runId), inArray(jobs.status, [...LIVE_JOB_STATUSES])),
      reason,
      actor: { type: 'system' },
      source: 'cascade',
    }),
  );
  const cancelledJobs = [...doneJobs, ...stoppedJobs];

  const cancelledJobIds = cancelledJobs.map((j) => j.id);
  const abortedSessionIds = cancelledJobs
    .map((j) => j.agentSessionId)
    .filter((id): id is string => typeof id === 'string');
  const deviceBySession = new Map<string, string>();
  for (const j of cancelledJobs) {
    if (j.agentSessionId && j.deviceId) deviceBySession.set(j.agentSessionId, j.deviceId);
  }

  // ISS-352 — a run that closed as `pipeline_completed` did NOT fail. The
  // terminal pipeline step (forge-test → released, forge-release → closed)
  // sets the issue to a terminal status as its LAST action while its own
  // job/session is still `running`; the cascade then reaps that very session.
  // Mapping a success-close to `failed` produced the false-failed badge the
  // reporter saw on ISS-351's forge-test / forge-release sessions. Only
  // genuine failure/cancel closes should mark the leftover sessions failed.
  //
  // ISS-219 — every live session of the run, not only those of the jobs just
  // stopped: a run session, a chat session, and the session of a job that
  // already ended are the run's children as much.
  const sessionTarget: 'completed' | 'failed' = completedSuccess ? 'completed' : 'failed';
  settled(
    await transitionSessions(tx, {
      to: sessionTarget,
      set: completedSuccess
        ? { failureReason: null, failureDetail: null, updatedAt: now }
        : {
            failureReason: reason,
            ...(cause ? { failureDetail: cause.detail } : {}),
            updatedAt: now,
          },
      where: and(
        or(
          eq(agentSessions.pipelineRunId, runId),
          inArray(
            agentSessions.id,
            tx.select({ id: jobs.agentSessionId }).from(jobs).where(eq(jobs.pipelineRunId, runId)),
          ),
        ),
        inArray(agentSessions.status, [...LIVE_SESSION_STATUSES]),
      ),
      returning: ['id'],
      reason,
      actor: { type: 'system' },
      source: 'cascade',
    }),
  );
  await refuseActiveChildLeft(tx, runId);

  const killableJobs = cancelledJobs.filter((j) => j.deviceId);

  return { cancelledJobIds, abortedSessionIds, deviceBySession, killableJobs };
}

/**
 * A child no machine edge could stop would fail its next write for ever under migration 0403's
 * trigger, which refuses these statuses under a closed run; it fails the close now instead.
 */
async function refuseActiveChildLeft(tx: Tx | Db, runId: string): Promise<void> {
  const [job] = await tx
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.pipelineRunId, runId), inArray(jobs.status, [...LIVE_JOB_STATUSES])))
    .limit(1);
  const [session] = job
    ? []
    : await tx
        .select({ id: agentSessions.id, status: agentSessions.status })
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.pipelineRunId, runId),
            inArray(agentSessions.status, [...LIVE_SESSION_STATUSES]),
          ),
        )
        .limit(1);
  const left = job ? { table: 'job', ...job } : session ? { table: 'session', ...session } : null;
  if (!left) return;
  throw new Error(
    `run close: ${left.table} ${left.id} is still \`${left.status}\` under pipeline_run ${runId} after the cascade, and no machine edge stops it; the close is refused rather than leave an active child under a terminal run`,
  );
}

export async function requestKillsForCascade(
  killableJobs: JobRow[],
  reason: CascadeReason,
): Promise<string[]> {
  if (killableJobs.length === 0) return [];
  const notified = new Set<string>();
  for (const job of killableJobs) {
    try {
      const outcome = await requestJobKill(job, reason);
      if (outcome === 'requested' && job.deviceId) notified.add(job.deviceId);
    } catch (err) {
      logger.error(
        { err, jobId: job.id, deviceId: job.deviceId },
        'cascadeCancelChildJobs: job.cancel kill request failed',
      );
    }
  }
  return Array.from(notified);
}

export function reasonForOutcome(outcome: 'completed' | 'failed' | 'cancelled'): CascadeReason {
  if (outcome === 'completed') return 'pipeline_completed';
  if (outcome === 'failed') return 'pipeline_failed';
  return 'pipeline_cancelled';
}
